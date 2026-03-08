import CryptoKit
import Foundation
import Observation
import PDFKit
import Security
import UIKit

enum SurfAceHTMLPatchResult {
    case success(updatedHTML: String)
    case selectorNotFound
    case invalidAction
    case failed(String)
}

@MainActor
protocol SurfAceSurfaceBridging: AnyObject {
    func render(frame: SurfAceFrame?)
    func fetchSnapshot(for frame: SurfAceFrame, includeImage: Bool) async -> SurfAceSurfaceSnapshot?
    func applyHTMLPatch(_ patch: SurfAceFramePatchRequest) async -> SurfAceHTMLPatchResult
    func removeDrawingStrokeIDs(_ strokeIDs: [String])
    func clearDrawings()
}

private struct SurfAceRequestReplayEntry {
    let payloadDigest: String
    let responseJSON: String
}

private struct SurfAceSessionState {
    var sessionId: String
    var providerId: String
    var connectionId: String
    var connectionUUID: String
    var socket: SurfAceWebSocket
    var sender: SurfAceOutboundSender
    var eventProfile: SurfAceEventProfile
    var drawingFlushConfig: SurfAceDrawingFlushConfig
}

private struct SurfAceResumeGraceState {
    let sessionId: String
    let providerId: String
    let expiresAt: Date
}

private struct SurfAceQueuedFrame {
    let order: Int
    let frame: SurfAceReadFrame
}

private struct SurfAceContextRecord {
    var contentId: String?
    var url: String?
    var liveFrame: SurfAceReadFrame?
    var liveDirtyStrokeIds: [String]
    var liveSeq: Int
    var closedFrames: [SurfAceQueuedFrame]
    let createdAt: Int64
    var lastActivityAt: Int64
}

private struct SurfAceReadRegisters {
    var taps: [SurfAceReadTap] = []
    var scrollPosition: SurfAceReadScrollPosition?
    var selection: SurfAceReadSelection?
    var page: SurfAceReadPage?
    var playbackPosition: Double?
    var playbackState: String?
    var lastNavigation: SurfAceReadNavigation?
    var overflowed: Bool = false
}

actor SurfAceOutboundSender {
    enum Priority: Int {
        case event = 0
        case response = 1
        case heartbeat = 2
    }

    private struct QueuedSend {
        let priority: Priority
        let sequence: Int
        let text: String
        let continuation: CheckedContinuation<Void, Error>
    }

    private let socket: SurfAceWebSocket
    private var queue: [QueuedSend] = []
    private var nextSequence = 0
    private var isDraining = false

    init(socket: SurfAceWebSocket) {
        self.socket = socket
    }

    func send(text: String, priority: Priority) async throws {
        try await withCheckedThrowingContinuation { continuation in
            nextSequence += 1
            queue.append(
                QueuedSend(
                    priority: priority,
                    sequence: nextSequence,
                    text: text,
                    continuation: continuation
                )
            )
            queue.sort { lhs, rhs in
                if lhs.priority == rhs.priority {
                    return lhs.sequence < rhs.sequence
                }
                return lhs.priority.rawValue > rhs.priority.rawValue
            }

            if !isDraining {
                isDraining = true
                Task {
                    await self.drainQueue()
                }
            }
        }
    }

    private func drainQueue() async {
        while !queue.isEmpty {
            let next = queue.removeFirst()
            do {
                try await socket.send(text: next.text)
                next.continuation.resume()
            } catch {
                next.continuation.resume(throwing: error)
                for pending in queue {
                    pending.continuation.resume(throwing: error)
                }
                queue.removeAll()
                isDraining = false
                return
            }
        }
        isDraining = false
    }
}

@MainActor
@Observable
final class SurfAceRuntime {
    var screenName: String
    var fingerprint: String
    var instanceDisambiguator: String
    var serverPort: Int = 0
    var currentFrame: SurfAceFrame?
    var frameHistory: [SurfAceFrame] = []
    var lastError: String?
    var lastEventSummary: String?
    var viewportSize: CGSize = .zero
    var viewportScale: CGFloat = 1
    var isDrawingFlushSending = false

    var stateLabel: String {
        if activeSession == nil {
            return resumeGrace == nil ? "Standby" : "Reconnecting"
        }
        if currentFrame == nil {
            return "Connected"
        }
        return "Displaying"
    }

    private let server = SurfAceHTTPServer()
    private let bonjourPublisher = SurfAceBonjourPublisher()
    private var surfaceBridge: SurfAceSurfaceBridging?
    private var identity: SurfAceIdentity?
    private var lastReportedPDFPage: Int?
    private var isStarted = false

    private var activeSession: SurfAceSessionState?
    private var resumeGrace: SurfAceResumeGraceState?
    private var resumeGraceTask: Task<Void, Never>?

    private var currentRevision = 0
    private var drawings: [SurfAceStroke] = []
    private var pendingFlushStrokes: [SurfAceStroke] = []
    private var firstPendingStrokeAt: Int64?
    private var lastPendingStrokeAt: Int64?
    private var lastSuccessfulFlushAt: Date?
    private var pendingFlushTask: Task<Void, Never>?

    private var contextRecords: [String: SurfAceContextRecord] = [:]
    private var activeAnnotationContextKey: String?
    private var activeNavigationURL: String?
    private var nextClosedFrameOrder = 0
    private var readRegisters = SurfAceReadRegisters()
    private var alertFired = false
    private var alertFiredAt: Date?

    private var eventCounter = 0
    private let resumeGraceMilliseconds = 20_000
    private let maxMessageBytes = 12 * 1024 * 1024
    private let maxFrameBytes = 10 * 1024 * 1024
    private let maxVisibleTextBytes = 4096
    private let maxStrokePointsPerFlush = 8192
    private let maxDrawingFlushBytes = 2 * 1024 * 1024
    private let webSocketPath = "/ws"
    private let healthPath = "/health"
    private let scaffoldOnlyOperations: [SurfAceSpecOperation] = []
    private let closedFramesPerReadLimit = 5
    private let closedFrameImageBudgetBytes = 4 * 1024 * 1024
    private let tapRegisterMaxEntries = 512
    private let alertResetTimeoutSeconds: TimeInterval = 10 * 60

    private var primarySurfaceID: String {
        SurfAceSurfaceID.fromFingerprint(fingerprint)
    }

    init() {
        let fallbackName = "Surf Ace"
        self.screenName = "\(fallbackName) - \(UIDevice.current.name)"
        self.fingerprint = "00000000"
        let vendorID = UIDevice.current.identifierForVendor?
            .uuidString
            .replacingOccurrences(of: "-", with: "")
            .lowercased() ?? "0000"
        self.instanceDisambiguator = String(vendorID.prefix(6))

        do {
            let identity = try SurfAceIdentityStore().loadOrCreateIdentity()
            self.identity = identity
            self.fingerprint = identity.fingerprint
        } catch {
            self.lastError = "Identity init failed: \(error.localizedDescription)"
        }

        bonjourPublisher.onPublishFailure = { [weak self] details in
            self?.lastError = "Bonjour publish failed (\(details)); WS server remains available"
        }
    }

    func start() async {
        guard !isStarted else { return }
        do {
            let port = try await server.start(
                webSocketPath: webSocketPath,
                httpHandler: { [weak self] request in
                    guard let self else {
                        return HTTPServerResponse(statusCode: 500)
                    }
                    return await self.handleHTTP(request: request)
                },
                webSocketHandler: { [weak self] socket in
                    guard let self else {
                        await socket.close(code: 4500, reason: "runtime_unavailable")
                        return
                    }
                    await self.handleWebSocket(socket)
                }
            )
            serverPort = Int(port)
            isStarted = true
            publishBonjour()
        } catch {
            lastError = "Server failed: \(error.localizedDescription)"
        }
    }

    func stop() async {
        endSession(clearFrame: true)
        cancelResumeGrace()
        await server.stop()
        bonjourPublisher.stop()
        isStarted = false
    }

    func attachSurfaceBridge(_ bridge: SurfAceSurfaceBridging) {
        surfaceBridge = bridge
        bridge.render(frame: currentFrame)
    }

    func updateViewport(size: CGSize, scale: CGFloat) {
        guard size.width > 0, size.height > 0 else {
            return
        }
        viewportSize = size
        viewportScale = scale
        refreshBonjourTXT()
    }

    func handleSelectionChanged(text: String, rect: CGRect?) {
        guard let frame = currentFrame,
              let rect,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              eventIsEnabled("event.selection") else {
            return
        }

        if frame.contentType == .html {
            readRegisters.selection = SurfAceReadSelection(
                selectedText: text.prefix(maxVisibleTextBytes).description,
                bounds: rect.surfAceRect,
                anchorStart: nil,
                anchorEnd: nil
            )
        }

        let selection = SurfAceSelection.text(text.prefix(maxVisibleTextBytes).description, boundingRect: rect.surfAceRect)
        sendEvent(
            op: "event.selection",
            payload: [
                "frameId": frame.frameID,
                "revision": currentRevision,
                "selection": jsonObject(fromEncodable: selection) ?? NSNull()
            ]
        )
    }

    func handleScrollSettled(viewport: SurfAceViewport, visibleText: String) {
        guard let frame = currentFrame else {
            return
        }

        readRegisters.scrollPosition = SurfAceReadScrollPosition(
            x: viewport.scrollOffset.x,
            y: viewport.scrollOffset.y,
            visibleRect: viewport.visibleRect
        )

        if eventIsEnabled("event.scroll") {
            sendEvent(
                op: "event.scroll",
                payload: [
                    "frameId": frame.frameID,
                    "revision": currentRevision,
                    "phase": "settled",
                    "viewport": jsonObject(fromEncodable: viewport) ?? NSNull(),
                    "visibleText": visibleText.prefix(maxVisibleTextBytes).description
                ]
            )
        }
        postPDFPageChangeIfNeeded(frame: frame, viewport: viewport)
    }

    func handleZoomSettled(viewport: SurfAceViewport, visibleText: String) {
        guard let frame = currentFrame else {
            return
        }

        readRegisters.scrollPosition = SurfAceReadScrollPosition(
            x: viewport.scrollOffset.x,
            y: viewport.scrollOffset.y,
            visibleRect: viewport.visibleRect
        )

        if eventIsEnabled("event.scroll") {
            sendEvent(
                op: "event.scroll",
                payload: [
                    "frameId": frame.frameID,
                    "revision": currentRevision,
                    "phase": "settled",
                    "viewport": jsonObject(fromEncodable: viewport) ?? NSNull(),
                    "visibleText": visibleText.prefix(maxVisibleTextBytes).description
                ]
            )
        }
        postPDFPageChangeIfNeeded(frame: frame, viewport: viewport)
    }

    func handleTapEvent(kind: String, position: SurfAcePoint, nearestContent: String) {
        guard let frame = currentFrame,
              eventIsEnabled("event.tap") else {
            return
        }

        let resolvedKind = (kind == "long_press") ? "long_press" : "tap"
        let tap = SurfAceReadTap(
            eventId: "tap_\(randomHex(byteCount: 8))",
            timestamp: timestampNow(),
            x: position.x,
            y: position.y,
            kind: resolvedKind,
            nearestText: nearestContent.prefix(maxVisibleTextBytes).description,
            elementRole: nil
        )
        readRegisters.taps.append(tap)
        if readRegisters.taps.count > tapRegisterMaxEntries {
            let overflowCount = readRegisters.taps.count - tapRegisterMaxEntries
            readRegisters.taps.removeFirst(overflowCount)
            readRegisters.overflowed = true
        }

        sendEvent(
            op: "event.tap",
            payload: [
                "frameId": frame.frameID,
                "revision": currentRevision,
                "kind": resolvedKind,
                "position": jsonObject(fromEncodable: position) ?? NSNull(),
                "nearestContent": nearestContent.prefix(maxVisibleTextBytes).description
            ]
        )
    }

    func handleNavigationEvent(url: String, sentAt: Int64? = nil) {
        guard let frame = currentFrame, frame.contentType == .html else {
            return
        }

        guard let normalized = normalizeURL(url) else {
            return
        }

        activeNavigationURL = normalized
        readRegisters.lastNavigation = SurfAceReadNavigation(url: normalized, navigatedAt: sentAt ?? timestampNow())
        sendEvent(
            op: "event.navigation",
            payload: [
                "frameId": frame.frameID,
                "revision": currentRevision,
                "url": normalized
            ]
        )
    }

    func handleNewStrokes(_ strokes: [SurfAceStroke]) {
        guard !strokes.isEmpty else {
            return
        }

        let now = timestampNow()
        for stroke in strokes {
            if let index = drawings.firstIndex(where: { $0.strokeId == stroke.strokeId }) {
                drawings[index] = stroke
            } else {
                drawings.append(stroke)
            }

            if let pendingIndex = pendingFlushStrokes.firstIndex(where: { $0.strokeId == stroke.strokeId }) {
                pendingFlushStrokes[pendingIndex] = stroke
            } else {
                pendingFlushStrokes.append(stroke)
                if firstPendingStrokeAt == nil {
                    firstPendingStrokeAt = stroke.points.first?.timestamp ?? now
                }
            }
        }

        if firstPendingStrokeAt == nil {
            firstPendingStrokeAt = now
        }
        lastPendingStrokeAt = strokes.compactMap { $0.points.last?.timestamp }.max() ?? now

        appendStrokesToDualChannelBuffer(strokes)
        scheduleDrawingFlushEvaluation()
    }

    func surfAceRead(fingerprint: String) -> SurfAceReadResult? {
        guard fingerprint == self.fingerprint else {
            return nil
        }

        resetAlertGateIfTimedOut()

        let liveContextKey = resolveLiveContextKey()
        var liveFrame: SurfAceReadFrame?
        var liveDirtyStrokeIds: [String]?
        var liveSeq: Int?

        if let liveContextKey, var context = contextRecords[liveContextKey], let frame = context.liveFrame {
            liveFrame = frame
            liveDirtyStrokeIds = context.liveDirtyStrokeIds
            liveSeq = context.liveSeq
            context.liveDirtyStrokeIds = []
            contextRecords[liveContextKey] = context
        }

        var queued: [(contextKey: String, item: SurfAceQueuedFrame)] = []
        for (contextKey, context) in contextRecords {
            for item in context.closedFrames {
                queued.append((contextKey: contextKey, item: item))
            }
        }
        queued.sort { lhs, rhs in
            lhs.item.order < rhs.item.order
        }

        var selected: [SurfAceReadFrame] = []
        var selectedOrdersByContext: [String: Set<Int>] = [:]
        var usedImageBytes = 0
        for entry in queued {
            if selected.count >= closedFramesPerReadLimit {
                break
            }

            let imageBytes = entry.item.frame.image.lengthOfBytes(using: .utf8)
            if usedImageBytes + imageBytes > closedFrameImageBudgetBytes {
                break
            }

            selected.append(entry.item.frame)
            selectedOrdersByContext[entry.contextKey, default: []].insert(entry.item.order)
            usedImageBytes += imageBytes
        }

        if !selectedOrdersByContext.isEmpty {
            for (contextKey, selectedOrders) in selectedOrdersByContext {
                guard var context = contextRecords[contextKey] else { continue }
                context.closedFrames.removeAll { selectedOrders.contains($0.order) }
                contextRecords[contextKey] = context
            }
        }

        let remainingClosedFrames = contextRecords.values.reduce(0) { partial, context in
            partial + context.closedFrames.count
        }

        let result = SurfAceReadResult(
            fingerprint: self.fingerprint,
            liveFrame: liveFrame,
            liveDirtyStrokeIds: liveDirtyStrokeIds,
            liveSeq: liveSeq,
            frames: selected,
            pendingFrames: remainingClosedFrames > 0 ? remainingClosedFrames : nil,
            taps: readRegisters.taps,
            scrollPosition: readRegisters.scrollPosition,
            selection: readRegisters.selection,
            page: readRegisters.page,
            playbackPosition: readRegisters.playbackPosition,
            playbackState: readRegisters.playbackState,
            lastNavigation: readRegisters.lastNavigation,
            overflowed: readRegisters.overflowed,
            readAt: timestampNow()
        )

        readRegisters.taps = []
        readRegisters.scrollPosition = nil
        readRegisters.selection = nil
        readRegisters.page = nil
        readRegisters.playbackPosition = nil
        readRegisters.playbackState = nil
        readRegisters.lastNavigation = nil
        readRegisters.overflowed = false

        alertFired = false
        alertFiredAt = nil

        return result
    }

    func hasNewLiveData(since liveSeq: Int?) -> Bool {
        guard let liveSeq else {
            return resolveLiveContextKey() != nil
        }
        guard let liveContextKey = resolveLiveContextKey(),
              let context = contextRecords[liveContextKey] else {
            return false
        }
        return context.liveSeq > liveSeq
    }

    private func appendStrokesToDualChannelBuffer(_ strokes: [SurfAceStroke]) {
        guard let contextKey = resolveContextKeyForCurrentContent(),
              let frame = currentFrame else {
            return
        }

        if let activeContextKey = activeAnnotationContextKey,
           activeContextKey != contextKey {
            finalizeLiveFrame(forContextKey: activeContextKey)
        }
        activeAnnotationContextKey = contextKey

        var context = contextRecords[contextKey]
            ?? SurfAceContextRecord(
                contentId: frame.frameID,
                url: activeNavigationURL,
                liveFrame: nil,
                liveDirtyStrokeIds: [],
                liveSeq: 0,
                closedFrames: [],
                createdAt: timestampNow(),
                lastActivityAt: timestampNow()
            )
        context.contentId = frame.frameID
        context.url = activeNavigationURL
        context.lastActivityAt = timestampNow()

        if context.liveFrame == nil {
            let openedAt = strokes.compactMap { $0.points.first?.timestamp }.min() ?? timestampNow()
            let frameID = randomHex(prefix: "fr", byteCount: 4)
            let readViewport = SurfAceReadFrameViewport(
                width: Double(max(viewportSize.width, 1)),
                height: Double(max(viewportSize.height, 1)),
                scale: Double(max(viewportScale, 1))
            )
            context.liveFrame = SurfAceReadFrame(
                frameId: frameID,
                contextKey: contextKey,
                contentId: frame.frameID,
                url: activeNavigationURL,
                scrollOffset: SurfAcePoint(x: 0, y: 0),
                viewport: readViewport,
                openedAt: openedAt,
                updatedAt: openedAt,
                image: "",
                strokes: []
            )
            updateLiveFrameSnapshot(frameID: frameID, contextKey: contextKey, frame: frame)
        }

        guard var liveFrame = context.liveFrame else {
            contextRecords[contextKey] = context
            return
        }

        for stroke in strokes {
            let converted = convertReadStroke(from: stroke)
            if let existingIndex = liveFrame.strokes.firstIndex(where: { $0.strokeId == converted.strokeId }) {
                liveFrame.strokes[existingIndex] = converted
            } else {
                liveFrame.strokes.append(converted)
            }

            if !context.liveDirtyStrokeIds.contains(converted.strokeId) {
                context.liveDirtyStrokeIds.append(converted.strokeId)
            }
            liveFrame.updatedAt = max(liveFrame.updatedAt, converted.endedAt)
        }

        context.liveSeq += 1
        context.liveFrame = liveFrame
        context.lastActivityAt = timestampNow()
        contextRecords[contextKey] = context
        markUnreadAnnotationActivity()
    }

    private func updateLiveFrameSnapshot(frameID: String, contextKey: String, frame: SurfAceFrame) {
        guard let surfaceBridge else {
            return
        }

        Task { [weak self] in
            guard let self else { return }
            let snapshot = await surfaceBridge.fetchSnapshot(for: frame, includeImage: true)
            await MainActor.run {
                guard var context = self.contextRecords[contextKey],
                      var liveFrame = context.liveFrame,
                      liveFrame.frameId == frameID else {
                    return
                }

                if let snapshot {
                    liveFrame.scrollOffset = snapshot.viewport.scrollOffset
                    liveFrame.viewport = SurfAceReadFrameViewport(
                        width: snapshot.viewport.visibleRect.width,
                        height: snapshot.viewport.visibleRect.height,
                        scale: Double(max(self.viewportScale, 1))
                    )
                    liveFrame.image = snapshot.imageBase64 ?? liveFrame.image
                }
                context.liveFrame = liveFrame
                context.lastActivityAt = self.timestampNow()
                self.contextRecords[contextKey] = context
            }
        }
    }

    private func finalizeActiveLiveFrame() {
        guard let activeAnnotationContextKey else {
            return
        }
        finalizeLiveFrame(forContextKey: activeAnnotationContextKey)
        self.activeAnnotationContextKey = nil
    }

    private func finalizeLiveFrame(forContextKey contextKey: String) {
        guard var context = contextRecords[contextKey],
              let liveFrame = context.liveFrame else {
            return
        }

        nextClosedFrameOrder += 1
        context.closedFrames.append(SurfAceQueuedFrame(order: nextClosedFrameOrder, frame: liveFrame))
        context.liveFrame = nil
        context.liveDirtyStrokeIds = []
        context.liveSeq = 0
        context.lastActivityAt = timestampNow()
        contextRecords[contextKey] = context
        markUnreadAnnotationActivity()
    }

    private func resolveContextKeyForCurrentContent() -> String? {
        guard let frame = currentFrame else {
            return nil
        }
        if frame.contentType == .html, let url = activeNavigationURL {
            return url
        }
        return frame.frameID
    }

    private func resolveLiveContextKey() -> String? {
        if let activeAnnotationContextKey,
           let context = contextRecords[activeAnnotationContextKey],
           context.liveFrame != nil {
            return activeAnnotationContextKey
        }

        return contextRecords.first { _, context in
            context.liveFrame != nil
        }?.key
    }

    private func markUnreadAnnotationActivity() {
        resetAlertGateIfTimedOut()
        guard !alertFired else {
            return
        }
        alertFired = true
        alertFiredAt = Date()
    }

    private func resetAlertGateIfTimedOut() {
        guard alertFired,
              let alertFiredAt,
              Date().timeIntervalSince(alertFiredAt) >= alertResetTimeoutSeconds else {
            return
        }
        alertFired = false
        self.alertFiredAt = nil
    }

    private func normalizeURL(_ url: String) -> String? {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            return nil
        }

        guard var components = URLComponents(string: trimmed) else {
            return trimmed
        }
        components.fragment = nil
        return components.string ?? trimmed
    }

    private func convertReadStroke(from stroke: SurfAceStroke) -> SurfAceReadStroke {
        var minX = Double.greatestFiniteMagnitude
        var minY = Double.greatestFiniteMagnitude
        var maxX = -Double.greatestFiniteMagnitude
        var maxY = -Double.greatestFiniteMagnitude
        var convertedPoints: [SurfAceReadStrokePoint] = []
        convertedPoints.reserveCapacity(stroke.points.count)

        for point in stroke.points {
            minX = min(minX, point.x)
            minY = min(minY, point.y)
            maxX = max(maxX, point.x)
            maxY = max(maxY, point.y)
            convertedPoints.append(SurfAceReadStrokePoint(x: point.x, y: point.y, pressure: point.pressure))
        }

        if convertedPoints.isEmpty {
            minX = 0
            minY = 0
            maxX = 0
            maxY = 0
        }

        let startedAt = stroke.points.first?.timestamp ?? timestampNow()
        let endedAt = stroke.points.last?.timestamp ?? startedAt
        return SurfAceReadStroke(
            strokeId: stroke.strokeId,
            points: convertedPoints,
            bbox: SurfAceRect(
                x: minX,
                y: minY,
                width: max(0, maxX - minX),
                height: max(0, maxY - minY)
            ),
            startedAt: startedAt,
            endedAt: endedAt
        )
    }

    private func handleHTTP(request: HTTPServerRequest) async -> HTTPServerResponse {
        guard request.method == "GET" else {
            return jsonResponse(statusCode: 404, body: ["error": "not_found"])
        }

        if request.path == healthPath {
            return jsonResponse(
                statusCode: 200,
                body: [
                    "status": "ok",
                    "paired": activeSession != nil,
                    "busy": isBusy,
                    "surface": [
                        "surfaceId": primarySurfaceID,
                        "name": screenName
                    ],
                    "http": [
                        "healthPath": healthPath,
                        "upgradePath": webSocketPath
                    ],
                    "ws": [
                        "version": 1,
                        "implementedOps": [
                            SurfAceSpecOperation.surfacesList.rawValue,
                            SurfAceSpecOperation.pairRequest.rawValue,
                            SurfAceSpecOperation.contentSet.rawValue,
                            SurfAceSpecOperation.contentAppend.rawValue,
                            SurfAceSpecOperation.contentPatch.rawValue,
                            SurfAceSpecOperation.contentClear.rawValue,
                            SurfAceSpecOperation.snapshotGet.rawValue,
                            SurfAceSpecOperation.annotationsRemove.rawValue,
                            SurfAceSpecOperation.heartbeatPing.rawValue
                        ],
                        "scaffoldOnlyOps": scaffoldOnlyOperations.map(\.rawValue)
                    ]
                ]
            )
        }

        return jsonResponse(statusCode: 404, body: ["error": "not_found"])
    }

    private func handleWebSocket(_ socket: SurfAceWebSocket) async {
        let connectionUUID = randomHex(prefix: "cn", byteCount: 8)
        let sender = SurfAceOutboundSender(socket: socket)
        var replayCache: [String: SurfAceRequestReplayEntry] = [:]
        var replayOrder: [String] = []

        while true {
            do {
                guard let message = try await socket.receive() else {
                    await handleSocketTermination(connectionUUID: connectionUUID, closeCode: nil, closeReason: nil)
                    return
                }

                switch message {
                case .close(let closeCode, let closeReason):
                    await handleSocketTermination(connectionUUID: connectionUUID, closeCode: closeCode, closeReason: closeReason)
                    return
                case .text(let text):
                    if text.lengthOfBytes(using: .utf8) > maxMessageBytes {
                        let id = "oversize"
                        let errorResponse = makeErrorResponse(op: "pair.request", id: id, code: "content_too_large", message: "message exceeds maxMessageBytes")
                        if let json = encodeJSON(errorResponse) {
                            try? await sender.send(text: json, priority: .response)
                        }
                        await socket.close(code: 4413, reason: "content_too_large")
                        await handleSocketTermination(connectionUUID: connectionUUID, closeCode: 4413, closeReason: "content_too_large")
                        return
                    }

                    guard let requestObject = decodeJSONObject(from: text),
                          let type = requestObject["type"] as? String,
                          type == "request",
                          let op = requestObject["op"] as? String,
                          let id = requestObject["id"] as? String else {
                        await socket.close(code: 4410, reason: "protocol_violation")
                        await handleSocketTermination(connectionUUID: connectionUUID, closeCode: 4410, closeReason: "protocol_violation")
                        return
                    }
                    let payload = requestObject["payload"] as? [String: Any] ?? [:]

                    let payloadDigest = payloadHash(["op": op, "payload": payload])
                    if let cached = replayCache[id] {
                        if cached.payloadDigest == payloadDigest {
                            let priority: SurfAceOutboundSender.Priority = (op == "heartbeat.ping") ? .heartbeat : .response
                            try await sender.send(text: cached.responseJSON, priority: priority)
                            continue
                        }
                        let mismatch = makeErrorResponse(
                            op: op,
                            id: id,
                            code: "invalid_request_id_reuse",
                            message: "request id reused with different payload"
                        )
                        if let mismatchJSON = encodeJSON(mismatch) {
                            try await sender.send(text: mismatchJSON, priority: .response)
                        }
                        continue
                    }

                    let responseObject = await processRequest(op: op, id: id, payload: payload, socket: socket, sender: sender, connectionUUID: connectionUUID)
                    guard let responseJSON = encodeJSON(responseObject) else {
                        await socket.close(code: 4500, reason: "internal_error")
                        await handleSocketTermination(connectionUUID: connectionUUID, closeCode: 4500, closeReason: "internal_error")
                        return
                    }

                    let priority: SurfAceOutboundSender.Priority = (op == "heartbeat.ping") ? .heartbeat : .response
                    try await sender.send(text: responseJSON, priority: priority)
                    replayCache[id] = SurfAceRequestReplayEntry(payloadDigest: payloadDigest, responseJSON: responseJSON)
                    replayOrder.append(id)
                    if replayOrder.count > 1024 {
                        let evicted = replayOrder.removeFirst()
                        replayCache.removeValue(forKey: evicted)
                    }
                }
            } catch {
                await handleSocketTermination(connectionUUID: connectionUUID, closeCode: nil, closeReason: nil)
                return
            }
        }
    }

    private func processRequest(
        op: String,
        id: String,
        payload: [String: Any],
        socket: SurfAceWebSocket,
        sender: SurfAceOutboundSender,
        connectionUUID: String
    ) async -> [String: Any] {
        switch op {
        case "surfaces.list":
            return handleSurfacesList(id: id)
        case "pair.request":
            return await handlePairRequest(id: id, payload: payload, socket: socket, sender: sender, connectionUUID: connectionUUID)
        case "content.set":
            return await handleContentSet(id: id, payload: payload, connectionUUID: connectionUUID)
        case "content.append":
            return await handleContentAppend(id: id, payload: payload, connectionUUID: connectionUUID)
        case "content.patch":
            return await handleContentPatch(id: id, payload: payload, connectionUUID: connectionUUID)
        case "content.clear":
            return await handleContentClear(id: id, payload: payload, connectionUUID: connectionUUID)
        case "frame.set":
            return await handleFrameSet(id: id, payload: payload, connectionUUID: connectionUUID)
        case "frame.append":
            return await handleFrameAppend(id: id, payload: payload, connectionUUID: connectionUUID)
        case "frame.patch":
            return await handleFramePatch(id: id, payload: payload, connectionUUID: connectionUUID)
        case "frame.clear":
            return await handleFrameClear(id: id, payload: payload, connectionUUID: connectionUUID)
        case "annotations.remove":
            return await handleAnnotationsRemove(id: id, payload: payload, connectionUUID: connectionUUID)
        case "snapshot.get":
            return await handleSnapshotGet(id: id, payload: payload, connectionUUID: connectionUUID)
        case "heartbeat.ping":
            return handleHeartbeatPing(id: id, payload: payload, connectionUUID: connectionUUID)
        default:
            return makeErrorResponse(op: op, id: id, code: "invalid_payload", message: "unsupported operation")
        }
    }

    private func handleSurfacesList(id: String) -> [String: Any] {
        [
            "v": 1,
            "type": "response",
            "op": SurfAceSpecOperation.surfacesList.rawValue,
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "surfaces": [
                    [
                        "surfaceId": primarySurfaceID,
                        "name": screenName,
                        "viewport": [
                            "width": max(Int(viewportSize.width.rounded()), 1),
                            "height": max(Int(viewportSize.height.rounded()), 1),
                            "scale": Double(max(viewportScale, 1))
                        ]
                    ]
                ]
            ]
        ]
    }

    private func handleContentSet(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard let contentId = payload["contentId"] as? String else {
            return makeErrorResponse(op: "content.set", id: id, code: "invalid_payload", message: "contentId is required")
        }
        var translated = payload
        translated["frameId"] = contentId
        let response = await handleFrameSet(id: id, payload: translated, connectionUUID: connectionUUID)
        return rewriteLegacyContentResponse(response, op: "content.set")
    }

    private func handleContentAppend(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard let contentId = payload["contentId"] as? String else {
            return makeErrorResponse(op: "content.append", id: id, code: "invalid_payload", message: "contentId is required")
        }
        var translated = payload
        translated["frameId"] = contentId
        let response = await handleFrameAppend(id: id, payload: translated, connectionUUID: connectionUUID)
        return rewriteLegacyContentResponse(response, op: "content.append")
    }

    private func handleContentPatch(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard let contentId = payload["contentId"] as? String else {
            return makeErrorResponse(op: "content.patch", id: id, code: "invalid_payload", message: "contentId is required")
        }
        var translated = payload
        translated["frameId"] = contentId
        let response = await handleFramePatch(id: id, payload: translated, connectionUUID: connectionUUID)
        return rewriteLegacyContentResponse(response, op: "content.patch")
    }

    private func handleContentClear(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        let response = await handleFrameClear(id: id, payload: payload, connectionUUID: connectionUUID)
        return rewriteLegacyContentResponse(response, op: "content.clear")
    }

    private func rewriteLegacyContentResponse(_ response: [String: Any], op: String) -> [String: Any] {
        var rewritten = response
        rewritten["op"] = op

        if var payload = rewritten["payload"] as? [String: Any] {
            if let currentFrameId = payload["currentFrameId"] {
                payload["currentContentId"] = currentFrameId
            }
            if let frameId = payload["frameId"] {
                payload["contentId"] = frameId
            }
            rewritten["payload"] = payload
        }

        if var error = rewritten["error"] as? [String: Any],
           let code = error["code"] as? String,
           code == "stale_frame" {
            error["code"] = "stale_content"
            rewritten["error"] = error
        }

        return rewritten
    }

    private func handlePairRequest(
        id: String,
        payload: [String: Any],
        socket: SurfAceWebSocket,
        sender: SurfAceOutboundSender,
        connectionUUID: String
    ) async -> [String: Any] {
        guard let providerId = payload["providerId"] as? String,
              let connectionId = payload["connectionId"] as? String,
              let protocolVersion = payload["protocolVersion"] as? Int else {
            return makeErrorResponse(op: "pair.request", id: id, code: "invalid_payload", message: "providerId, connectionId, protocolVersion are required")
        }

        guard protocolVersion == 1 else {
            return makeErrorResponse(op: "pair.request", id: id, code: "unsupported_protocol_version", message: "protocolVersion must be 1")
        }

        if let requestedSurfaceID = payload["surfaceId"] as? String,
           requestedSurfaceID != primarySurfaceID {
            return makeErrorResponse(op: "pair.request", id: id, code: "invalid_payload", message: "unknown surfaceId")
        }

        let takeover = payload["takeover"] as? Bool ?? false
        let eventProfile = SurfAceEventProfile(rawValue: payload["eventProfile"] as? String ?? "") ?? .minimumDeep
        let drawingFlushConfig = parseDrawingFlushConfig(payload["drawingFlushConfig"] as? [String: Any])

        let requestedResumeSessionId: String? = {
            guard let resume = payload["resume"] as? [String: Any] else { return nil }
            return resume["sessionId"] as? String
        }()

        if let session = activeSession {
            if session.connectionUUID == connectionUUID {
                activeSession?.connectionId = connectionId
                activeSession?.sender = sender
                activeSession?.eventProfile = eventProfile
                activeSession?.drawingFlushConfig = drawingFlushConfig
                refreshBonjourTXT()
                scheduleDrawingFlushEvaluation()
                return makePairSuccessResponse(id: id, sessionId: session.sessionId, resumed: true, profile: eventProfile, flushConfig: drawingFlushConfig)
            }

            if providerId == session.providerId, takeover {
                let previousSocket = session.socket
                activeSession = SurfAceSessionState(
                    sessionId: session.sessionId,
                    providerId: providerId,
                    connectionId: connectionId,
                    connectionUUID: connectionUUID,
                    socket: socket,
                    sender: sender,
                    eventProfile: eventProfile,
                    drawingFlushConfig: drawingFlushConfig
                )
                refreshBonjourTXT()
                scheduleDrawingFlushEvaluation()
                await previousSocket.close(code: 1000, reason: "superseded")
                return makePairSuccessResponse(id: id, sessionId: session.sessionId, resumed: true, profile: eventProfile, flushConfig: drawingFlushConfig)
            }

            return makeErrorResponse(op: "pair.request", id: id, code: "busy", message: "surface already paired")
        }

        if let grace = resumeGrace {
            if Date() <= grace.expiresAt, providerId == grace.providerId {
                if let requestedResumeSessionId, requestedResumeSessionId != grace.sessionId {
                    return makeErrorResponse(op: "pair.request", id: id, code: "busy", message: "resume sessionId mismatch")
                }
                cancelResumeGrace()
                activeSession = SurfAceSessionState(
                    sessionId: grace.sessionId,
                    providerId: providerId,
                    connectionId: connectionId,
                    connectionUUID: connectionUUID,
                    socket: socket,
                    sender: sender,
                    eventProfile: eventProfile,
                    drawingFlushConfig: drawingFlushConfig
                )
                refreshBonjourTXT()
                scheduleDrawingFlushEvaluation()
                sendSnapshotHint(reason: "after_reconnect")
                return makePairSuccessResponse(id: id, sessionId: grace.sessionId, resumed: true, profile: eventProfile, flushConfig: drawingFlushConfig)
            }
        }

        let sessionId = randomHex(prefix: "sa", byteCount: 16)
        cancelResumeGrace()
        activeSession = SurfAceSessionState(
            sessionId: sessionId,
            providerId: providerId,
            connectionId: connectionId,
            connectionUUID: connectionUUID,
            socket: socket,
            sender: sender,
            eventProfile: eventProfile,
            drawingFlushConfig: drawingFlushConfig
        )
        refreshBonjourTXT()
        scheduleDrawingFlushEvaluation()

        return makePairSuccessResponse(id: id, sessionId: sessionId, resumed: false, profile: eventProfile, flushConfig: drawingFlushConfig)
    }

    private func handleFrameSet(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard isAuthorizedConnection(connectionUUID) else {
            return makeErrorResponse(op: "frame.set", id: id, code: "not_paired", message: "pair.request required")
        }

        guard let revision = parseInt(payload["revision"]) else {
            return makeErrorResponse(op: "frame.set", id: id, code: "invalid_payload", message: "revision is required")
        }

        if let error = staleRevisionError(op: "frame.set", id: id, revision: revision) {
            return error
        }

        if let contentObject = payload["content"],
           JSONSerialization.isValidJSONObject(contentObject),
           let serializedContent = try? JSONSerialization.data(withJSONObject: contentObject),
           serializedContent.count > maxFrameBytes {
            return makeErrorResponse(op: "frame.set", id: id, code: "content_too_large", message: "frame content exceeds maxFrameBytes")
        }

        do {
            let frame = try SurfAceFrame.from(jsonObject: payload)
            if let validation = validateFrame(frame) {
                return makeErrorResponse(op: "frame.set", id: id, code: validation.code, message: validation.message)
            }

            finalizeActiveLiveFrame()
            currentRevision = revision
            currentFrame = frame
            frameHistory.append(frame)
            drawings.removeAll()
            pendingFlushStrokes.removeAll()
            clearPendingFlushState()
            activeNavigationURL = nil
            lastReportedPDFPage = nil
            surfaceBridge?.render(frame: frame)
            surfaceBridge?.clearDrawings()
            refreshBonjourTXT()
            sendSnapshotHint(reason: "after_render")
            return makeMutationAck(op: "frame.set", id: id)
        } catch SurfAceFrameParseError.unsupportedType {
            return makeErrorResponse(op: "frame.set", id: id, code: "unsupported_content_type", message: "unsupported contentType")
        } catch SurfAceFrameParseError.invalidFrameID {
            return makeErrorResponse(op: "frame.set", id: id, code: "invalid_payload", message: "frameId/contentId must match (fr|ct)_<8 lowercase hex>")
        } catch SurfAceFrameParseError.missingField(let field) {
            return makeErrorResponse(op: "frame.set", id: id, code: "invalid_payload", message: "missing \(field)")
        } catch {
            return makeErrorResponse(op: "frame.set", id: id, code: "render_failed", message: error.localizedDescription)
        }
    }

    private func handleFrameAppend(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard isAuthorizedConnection(connectionUUID) else {
            return makeErrorResponse(op: "frame.append", id: id, code: "not_paired", message: "pair.request required")
        }

        guard let revision = parseInt(payload["revision"]) else {
            return makeErrorResponse(op: "frame.append", id: id, code: "invalid_payload", message: "revision is required")
        }

        if let error = staleRevisionError(op: "frame.append", id: id, revision: revision) {
            return error
        }

        do {
            let appendRequest = try SurfAceFrameAppendRequest.from(jsonObject: payload)
            guard let frame = currentFrame else {
                return makeErrorResponse(op: "frame.append", id: id, code: "stale_frame", message: "no active frame")
            }
            guard frame.frameID == appendRequest.frameID else {
                return makeErrorResponse(op: "frame.append", id: id, code: "stale_frame", message: "frameId is not current")
            }
            guard case .terminal(let existingLines, let scrollback) = frame.payload else {
                return makeErrorResponse(op: "frame.append", id: id, code: "unsupported_operation_for_content_type", message: "append is terminal-only")
            }

            let mergedLines = existingLines + appendRequest.lines
            let retainedByScrollback: [String]
            if scrollback > 0 {
                retainedByScrollback = Array(mergedLines.suffix(scrollback))
            } else {
                retainedByScrollback = mergedLines
            }

            let updatedFrame = SurfAceFrame(
                frameID: frame.frameID,
                contentType: frame.contentType,
                payload: .terminal(lines: retainedByScrollback, scrollback: scrollback),
                title: frame.title,
                scrollable: frame.scrollable,
                interactive: frame.interactive
            )
            currentRevision = revision
            currentFrame = updatedFrame
            frameHistory.append(updatedFrame)
            surfaceBridge?.render(frame: updatedFrame)
            refreshBonjourTXT()
            sendSnapshotHint(reason: "after_render")
            return makeMutationAck(op: "frame.append", id: id)
        } catch SurfAceFrameParseError.missingField(let field) {
            return makeErrorResponse(op: "frame.append", id: id, code: "invalid_payload", message: "missing \(field)")
        } catch {
            return makeErrorResponse(op: "frame.append", id: id, code: "invalid_payload", message: "invalid append payload")
        }
    }

    private func handleFramePatch(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard isAuthorizedConnection(connectionUUID) else {
            return makeErrorResponse(op: "frame.patch", id: id, code: "not_paired", message: "pair.request required")
        }

        guard let revision = parseInt(payload["revision"]) else {
            return makeErrorResponse(op: "frame.patch", id: id, code: "invalid_payload", message: "revision is required")
        }

        if let error = staleRevisionError(op: "frame.patch", id: id, revision: revision) {
            return error
        }

        do {
            let patchRequest = try SurfAceFramePatchRequest.from(jsonObject: payload)
            guard let frame = currentFrame else {
                return makeErrorResponse(op: "frame.patch", id: id, code: "stale_frame", message: "no active frame")
            }
            guard frame.frameID == patchRequest.frameID else {
                return makeErrorResponse(op: "frame.patch", id: id, code: "stale_frame", message: "frameId is not current")
            }
            guard case .html(_, let baseURL) = frame.payload else {
                return makeErrorResponse(op: "frame.patch", id: id, code: "unsupported_operation_for_content_type", message: "patch is html-only")
            }

            switch await surfaceBridge?.applyHTMLPatch(patchRequest) ?? .failed("surface unavailable") {
            case .success(let updatedHTML):
                let updatedFrame = SurfAceFrame(
                    frameID: frame.frameID,
                    contentType: frame.contentType,
                    payload: .html(html: updatedHTML, baseURL: baseURL),
                    title: frame.title,
                    scrollable: frame.scrollable,
                    interactive: frame.interactive
                )
                currentRevision = revision
                currentFrame = updatedFrame
                frameHistory.append(updatedFrame)
                surfaceBridge?.render(frame: updatedFrame)
                refreshBonjourTXT()
                sendSnapshotHint(reason: "after_render")
                return makeMutationAck(op: "frame.patch", id: id)
            case .selectorNotFound:
                return makeErrorResponse(op: "frame.patch", id: id, code: "render_failed", message: "patch selector did not match any element")
            case .invalidAction:
                return makeErrorResponse(op: "frame.patch", id: id, code: "render_failed", message: "patch action is not supported")
            case .failed(let message):
                return makeErrorResponse(op: "frame.patch", id: id, code: "render_failed", message: message)
            }
        } catch SurfAceFrameParseError.missingField(let field) {
            return makeErrorResponse(op: "frame.patch", id: id, code: "invalid_payload", message: "missing \(field)")
        } catch {
            return makeErrorResponse(op: "frame.patch", id: id, code: "invalid_payload", message: "invalid patch payload")
        }
    }

    private func handleFrameClear(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard isAuthorizedConnection(connectionUUID) else {
            return makeErrorResponse(op: "frame.clear", id: id, code: "not_paired", message: "pair.request required")
        }

        guard let revision = parseInt(payload["revision"]) else {
            return makeErrorResponse(op: "frame.clear", id: id, code: "invalid_payload", message: "revision is required")
        }

        if let error = staleRevisionError(op: "frame.clear", id: id, revision: revision) {
            return error
        }

        finalizeActiveLiveFrame()
        currentRevision = revision
        activeNavigationURL = nil
        clearFrame()
        sendSnapshotHint(reason: "after_render")
        return makeMutationAck(op: "frame.clear", id: id)
    }

    private func handleAnnotationsRemove(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard isAuthorizedConnection(connectionUUID) else {
            return makeErrorResponse(op: "annotations.remove", id: id, code: "not_paired", message: "pair.request required")
        }

        let requestedContentID = (payload["contentId"] as? String) ?? (payload["frameId"] as? String)
        guard let requestedContentID,
              let strokeIDs = payload["strokeIds"] as? [String],
              !strokeIDs.isEmpty else {
            return makeErrorResponse(op: "annotations.remove", id: id, code: "invalid_payload", message: "contentId/frameId and strokeIds are required")
        }

        guard let frame = currentFrame, frame.frameID == requestedContentID else {
            let staleCode = payload["contentId"] == nil ? "stale_frame" : "stale_content"
            return makeErrorResponse(op: "annotations.remove", id: id, code: staleCode, message: "contentId/frameId is not current")
        }

        var removed: [String] = []
        var notFound: [String] = []
        for strokeID in strokeIDs {
            if let index = drawings.firstIndex(where: { $0.strokeId == strokeID }) {
                drawings.remove(at: index)
                pendingFlushStrokes.removeAll(where: { $0.strokeId == strokeID })
                removed.append(strokeID)
            } else {
                notFound.append(strokeID)
            }
        }

        if !removed.isEmpty {
            surfaceBridge?.removeDrawingStrokeIDs(removed)
        }

        return [
            "v": 1,
            "type": "response",
            "op": "annotations.remove",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "contentId": frame.frameID,
                "frameId": frame.frameID,
                "removedStrokeIds": removed,
                "notFoundStrokeIds": notFound,
                "remainingStrokeCount": drawings.count
            ]
        ]
    }

    private func handleSnapshotGet(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard isAuthorizedConnection(connectionUUID) else {
            return makeErrorResponse(op: "snapshot.get", id: id, code: "not_paired", message: "pair.request required")
        }

        let includeImage = payload["includeImage"] as? Bool ?? false
        let includeVisibleText = payload["includeVisibleText"] as? Bool ?? true
        let includeDrawings = payload["includeDrawings"] as? Bool ?? false

        guard let frame = currentFrame else {
            var responsePayload: [String: Any] = [
                "contentId": NSNull(),
                "frameId": NSNull(),
                "revision": currentRevision,
                "contentType": NSNull(),
                "viewport": jsonObject(fromEncodable: defaultViewport()) ?? NSNull(),
                "selection": NSNull()
            ]
            if includeVisibleText {
                responsePayload["visibleText"] = ""
            }
            if includeDrawings {
                responsePayload["drawings"] = []
            }
            if includeImage {
                responsePayload["image"] = ""
            }
            return [
                "v": 1,
                "type": "response",
                "op": "snapshot.get",
                "id": id,
                "ok": true,
                "sentAt": timestampNow(),
                "payload": responsePayload
            ]
        }

        let snapshot = await surfaceBridge?.fetchSnapshot(for: frame, includeImage: includeImage)
        let visibleText: String
        if includeVisibleText {
            visibleText = (snapshot?.visibleText ?? fallbackVisibleText(for: frame)).prefix(maxVisibleTextBytes).description
        } else {
            visibleText = ""
        }

        var responsePayload: [String: Any] = [
            "contentId": frame.frameID,
            "frameId": frame.frameID,
            "revision": currentRevision,
            "contentType": frame.contentType.rawValue,
            "viewport": jsonObject(fromEncodable: snapshot?.viewport ?? defaultViewport()) ?? NSNull(),
            "selection": jsonObject(fromEncodable: snapshot?.selection) ?? NSNull()
        ]
        if includeVisibleText {
            responsePayload["visibleText"] = visibleText
        }

        if includeDrawings {
            responsePayload["drawings"] = jsonObject(fromEncodable: drawings) ?? []
        }

        if includeImage, let image = snapshot?.imageBase64 {
            responsePayload["image"] = image
        }

        return [
            "v": 1,
            "type": "response",
            "op": "snapshot.get",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": responsePayload
        ]
    }

    private func handleHeartbeatPing(id: String, payload: [String: Any], connectionUUID: String) -> [String: Any] {
        guard isAuthorizedConnection(connectionUUID) else {
            return makeErrorResponse(op: "heartbeat.ping", id: id, code: "not_paired", message: "pair.request required")
        }

        guard let nonce = payload["nonce"] as? String, !nonce.isEmpty else {
            return makeErrorResponse(op: "heartbeat.ping", id: id, code: "invalid_payload", message: "nonce is required")
        }

        return [
            "v": 1,
            "type": "response",
            "op": "heartbeat.ping",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "nonce": nonce
            ]
        ]
    }

    private func isAuthorizedConnection(_ connectionUUID: String) -> Bool {
        guard let session = activeSession else {
            return false
        }
        return session.connectionUUID == connectionUUID
    }

    private func staleRevisionError(op: String, id: String, revision: Int) -> [String: Any]? {
        let expected = currentRevision + 1
        guard revision == expected else {
            return makeErrorResponse(
                op: op,
                id: id,
                code: "stale_revision",
                message: "expected revision \(expected)",
                details: ["expectedRevision": expected]
            )
        }
        return nil
    }

    private func makePairSuccessResponse(
        id: String,
        sessionId: String,
        resumed: Bool,
        profile: SurfAceEventProfile,
        flushConfig: SurfAceDrawingFlushConfig
    ) -> [String: Any] {
        let viewport: [String: Any] = [
            "width": max(Int(viewportSize.width.rounded()), 1),
            "height": max(Int(viewportSize.height.rounded()), 1),
            "scale": Double(max(viewportScale, 1))
        ]
        let statePayload: [String: Any] = [
            "currentContentId": currentFrame?.frameID ?? NSNull(),
            "currentFrameId": currentFrame?.frameID ?? NSNull(),
            "currentRevision": currentRevision,
            "contentType": currentFrame?.contentType.rawValue ?? NSNull()
        ]
        let payload: [String: Any] = [
            "sessionId": sessionId,
            "resumed": resumed,
            "surfaceId": primarySurfaceID,
            "surfaceName": screenName,
            "viewport": viewport,
            "capabilities": [
                "contentTypes": ["html", "image", "pdf", "terminal", "markdown"],
                "eventTypes": profile.activeEvents
            ],
            "eventConfig": [
                "profile": profile.rawValue,
                "activeEvents": profile.activeEvents,
                "drawingFlushConfig": [
                    "idleWindowMs": flushConfig.idleWindowMs,
                    "maxIntervalMs": flushConfig.maxIntervalMs
                ]
            ],
            "limits": [
                "maxMessageBytes": maxMessageBytes,
                "maxFrameBytes": maxFrameBytes,
                "maxVisibleTextBytes": maxVisibleTextBytes,
                "maxStrokePointsPerFlush": maxStrokePointsPerFlush,
                "maxDrawingFlushBytes": maxDrawingFlushBytes
            ],
            "state": statePayload
        ]

        return [
            "v": 1,
            "type": "response",
            "op": "pair.request",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": payload
        ]
    }

    private func makeMutationAck(op: String, id: String) -> [String: Any] {
        let statePayload: [String: Any] = [
            "currentFrameId": currentFrame?.frameID ?? NSNull(),
            "currentRevision": currentRevision,
            "contentType": currentFrame?.contentType.rawValue ?? NSNull()
        ]

        return [
            "v": 1,
            "type": "response",
            "op": op,
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": statePayload
        ]
    }

    private func makeErrorResponse(
        op: String,
        id: String,
        code: String,
        message: String,
        details: [String: Any]? = nil
    ) -> [String: Any] {
        var errorPayload: [String: Any] = [
            "code": code,
            "message": message
        ]
        if let details {
            errorPayload["details"] = details
        }

        return [
            "v": 1,
            "type": "response",
            "op": op,
            "id": id,
            "ok": false,
            "sentAt": timestampNow(),
            "error": errorPayload
        ]
    }

    private func handleSocketTermination(connectionUUID: String, closeCode: UInt16?, closeReason: String?) async {
        guard let session = activeSession, session.connectionUUID == connectionUUID else {
            return
        }

        activeSession = nil
        refreshBonjourTXT()

        if closeCode == 1000, closeReason == "provider_shutdown" {
            clearFrame()
            drawings.removeAll()
            pendingFlushStrokes.removeAll()
            clearPendingFlushState()
            cancelResumeGrace()
            refreshBonjourTXT()
            return
        }

        startResumeGrace(sessionId: session.sessionId, providerId: session.providerId)
    }

    private func startResumeGrace(sessionId: String, providerId: String) {
        cancelResumeGrace()

        let expiry = Date().addingTimeInterval(Double(resumeGraceMilliseconds) / 1000)
        resumeGrace = SurfAceResumeGraceState(sessionId: sessionId, providerId: providerId, expiresAt: expiry)
        refreshBonjourTXT()

        resumeGraceTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(self?.resumeGraceMilliseconds ?? 20_000) * 1_000_000)
            } catch {
                return
            }
            await MainActor.run {
                guard let self else { return }
                guard self.activeSession == nil,
                      let grace = self.resumeGrace,
                      grace.sessionId == sessionId,
                      grace.providerId == providerId,
                      grace.expiresAt <= Date() else {
                    return
                }
                self.resumeGrace = nil
                self.clearFrame()
                self.drawings.removeAll()
                self.pendingFlushStrokes.removeAll()
                self.clearPendingFlushState()
                self.refreshBonjourTXT()
            }
        }
    }

    private func cancelResumeGrace() {
        resumeGraceTask?.cancel()
        resumeGraceTask = nil
        resumeGrace = nil
        refreshBonjourTXT()
    }

    private func sendEvent(op: String, payload: [String: Any]) {
        guard let session = activeSession, session.eventProfile.activeEvents.contains(op) else {
            return
        }

        eventCounter += 1
        let eventId = "ev_\(eventCounter)_\(randomHex(byteCount: 4))"
        let envelope: [String: Any] = [
            "v": 1,
            "type": "event",
            "op": op,
            "eventId": eventId,
            "sentAt": timestampNow(),
            "payload": payload
        ]

        guard let json = encodeJSON(envelope) else {
            lastError = "Event encode failed: \(op)"
            return
        }

        Task {
            do {
                try await session.sender.send(text: json, priority: .event)
                await MainActor.run {
                    self.lastEventSummary = op
                }
            } catch {
                await MainActor.run {
                    self.lastError = "Event send failed: \(error.localizedDescription)"
                }
            }
        }
    }

    private func sendSnapshotHint(reason: String) {
        guard eventIsEnabled("event.snapshot_hint") else { return }
        sendEvent(op: "event.snapshot_hint", payload: ["reason": reason])
    }

    private func eventIsEnabled(_ eventName: String) -> Bool {
        guard let session = activeSession else { return false }
        return session.eventProfile.activeEvents.contains(eventName)
    }

    private func postPDFPageChangeIfNeeded(frame: SurfAceFrame, viewport: SurfAceViewport) {
        guard eventIsEnabled("event.page"),
              case .pdf(let data) = frame.payload,
              let decoded = Data(base64Encoded: data, options: [.ignoreUnknownCharacters]),
              let document = PDFDocument(data: decoded) else {
            return
        }

        let totalPages = max(document.pageCount, 1)
        let scrollableHeight = max(viewport.contentSize.height - viewport.visibleRect.height, 1)
        let progress = min(max(viewport.scrollOffset.y / scrollableHeight, 0), 1)
        let estimatedPage = min(max(Int((progress * Double(totalPages - 1)).rounded(.down)) + 1, 1), totalPages)

        guard estimatedPage != lastReportedPDFPage else {
            return
        }
        lastReportedPDFPage = estimatedPage
        readRegisters.page = SurfAceReadPage(
            pageNumber: estimatedPage,
            pageCount: totalPages,
            pageLabel: "\(estimatedPage)"
        )

        let pageText = document.page(at: estimatedPage - 1)?.string ?? ""
        sendEvent(
            op: "event.page",
            payload: [
                "frameId": frame.frameID,
                "revision": currentRevision,
                "page": estimatedPage,
                "totalPages": totalPages,
                "pageText": pageText.prefix(maxVisibleTextBytes).description
            ]
        )
    }

    private func scheduleDrawingFlushEvaluation() {
        pendingFlushTask?.cancel()

        guard !pendingFlushStrokes.isEmpty,
              let session = activeSession,
              let lastDirtyAt = lastPendingStrokeAt else {
            return
        }

        let config = session.drawingFlushConfig
        let now = Date()
        let idleDeadline = Date(timeIntervalSince1970: TimeInterval(lastDirtyAt) / 1000).addingTimeInterval(TimeInterval(config.idleWindowMs) / 1000)
        let maxBase = lastSuccessfulFlushAt ?? Date(timeIntervalSince1970: TimeInterval(firstPendingStrokeAt ?? lastDirtyAt) / 1000)
        let maxDeadline = maxBase.addingTimeInterval(TimeInterval(config.maxIntervalMs) / 1000)

        let nextFire = min(idleDeadline, maxDeadline)
        let delay = max(0, nextFire.timeIntervalSince(now))

        pendingFlushTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000))
            } catch {
                return
            }
            await MainActor.run {
                self?.evaluateDrawingFlush()
            }
        }
    }

    private func evaluateDrawingFlush() {
        guard !pendingFlushStrokes.isEmpty,
              let session = activeSession,
              let frame = currentFrame,
              let lastDirtyAt = lastPendingStrokeAt else {
            return
        }

        let config = session.drawingFlushConfig
        let now = Date()
        let lastSend = lastSuccessfulFlushAt ?? .distantPast
        let lastDirty = Date(timeIntervalSince1970: TimeInterval(lastDirtyAt) / 1000)

        let idleSatisfied = now.timeIntervalSince(lastDirty) >= TimeInterval(config.idleWindowMs) / 1000 &&
            now.timeIntervalSince(lastSend) >= TimeInterval(config.idleWindowMs) / 1000
        let maxSatisfied = now.timeIntervalSince(lastSend) >= TimeInterval(config.maxIntervalMs) / 1000

        guard idleSatisfied || maxSatisfied else {
            scheduleDrawingFlushEvaluation()
            return
        }

        let flushReason = idleSatisfied ? "idle_window" : "max_interval"
        let strokesToSend = pendingFlushStrokes
        let pointsCount = strokesToSend.reduce(0) { $0 + $1.points.count }
        if pointsCount > maxStrokePointsPerFlush {
            let trimmed = trimStrokes(strokesToSend, maxPoints: maxStrokePointsPerFlush)
            sendDrawingFlush(frameID: frame.frameID, flushReason: flushReason, config: config, strokes: trimmed)
            pendingFlushStrokes = Array(pendingFlushStrokes.dropFirst(trimmed.count))
        } else {
            sendDrawingFlush(frameID: frame.frameID, flushReason: flushReason, config: config, strokes: strokesToSend)
            pendingFlushStrokes.removeAll()
        }

        if pendingFlushStrokes.isEmpty {
            clearPendingFlushState()
        } else {
            firstPendingStrokeAt = pendingFlushStrokes.first?.points.first?.timestamp
            lastPendingStrokeAt = pendingFlushStrokes.last?.points.last?.timestamp
            scheduleDrawingFlushEvaluation()
        }
    }

    private func sendDrawingFlush(
        frameID: String,
        flushReason: String,
        config: SurfAceDrawingFlushConfig,
        strokes: [SurfAceStroke]
    ) {
        guard !strokes.isEmpty else {
            return
        }

        let pointsCount = strokes.reduce(0) { $0 + $1.points.count }
        let firstStrokeAt = strokes.first?.points.first?.timestamp ?? timestampNow()
        let lastStrokeAt = strokes.last?.points.last?.timestamp ?? timestampNow()
        let flushId = "fl_\(randomHex(byteCount: 8))"

        let payload: [String: Any] = [
            "frameId": frameID,
            "revision": currentRevision,
            "flushId": flushId,
            "flushReason": flushReason,
            "idleWindowMs": config.idleWindowMs,
            "maxIntervalMs": config.maxIntervalMs,
            "strokes": jsonObject(fromEncodable: strokes) ?? [],
            "strokeCount": strokes.count,
            "pointsCount": pointsCount,
            "firstStrokeAt": firstStrokeAt,
            "lastStrokeAt": lastStrokeAt
        ]

        guard let payloadData = try? JSONSerialization.data(withJSONObject: payload), payloadData.count <= maxDrawingFlushBytes else {
            lastError = "drawing_flush payload exceeded maxDrawingFlushBytes"
            return
        }

        guard let session = activeSession,
              let json = encodeJSON([
                  "v": 1,
                  "type": "event",
                  "op": "event.drawing_flush",
                  "eventId": "ev_\(eventCounter + 1)_\(randomHex(byteCount: 4))",
                  "sentAt": timestampNow(),
                  "payload": payload
              ]) else {
            return
        }

        isDrawingFlushSending = true
        eventCounter += 1
        Task {
            do {
                try await session.sender.send(text: json, priority: .event)
                await MainActor.run {
                    self.lastSuccessfulFlushAt = Date()
                    self.lastEventSummary = "event.drawing_flush"
                    self.isDrawingFlushSending = false
                }
            } catch {
                await MainActor.run {
                    self.lastError = "Drawing flush send failed: \(error.localizedDescription)"
                    self.isDrawingFlushSending = false
                    self.scheduleDrawingFlushEvaluation()
                }
            }
        }
    }

    private func trimStrokes(_ strokes: [SurfAceStroke], maxPoints: Int) -> [SurfAceStroke] {
        var remaining = maxPoints
        var result: [SurfAceStroke] = []

        for stroke in strokes {
            guard remaining > 0 else { break }
            if stroke.points.count <= remaining {
                result.append(stroke)
                remaining -= stroke.points.count
            } else {
                let truncatedPoints = Array(stroke.points.prefix(remaining))
                if !truncatedPoints.isEmpty {
                    result.append(SurfAceStroke(strokeId: stroke.strokeId, points: truncatedPoints, tool: stroke.tool))
                }
                remaining = 0
            }
        }

        return result
    }

    private func clearPendingFlushState() {
        pendingFlushTask?.cancel()
        pendingFlushTask = nil
        firstPendingStrokeAt = nil
        lastPendingStrokeAt = nil
    }

    private func publishBonjour() {
        guard serverPort > 0 else { return }
        bonjourPublisher.publish(name: bonjourServiceInstanceName(), port: serverPort, txtRecord: txtRecord())
    }

    private func refreshBonjourTXT() {
        guard serverPort > 0 else { return }
        bonjourPublisher.updateTXTRecord(txtRecord())
    }

    func bonjourServiceInstanceName() -> String {
        let suffix = " \(fingerprint)-\(instanceDisambiguator)"
        let maxNameLength = 63
        let baseLimit = max(1, maxNameLength - suffix.count)
        let base = String(screenName.prefix(baseLimit))
        return "\(base)\(suffix)"
    }

    private var isBusy: Bool {
        activeSession != nil || resumeGrace != nil
    }

    private func txtRecord() -> [String: String] {
        let width = max(Int(viewportSize.width.rounded()), 1)
        let height = max(Int(viewportSize.height.rounded()), 1)
        return [
            "name": screenName,
            "v": "1",
            "w": "\(width)",
            "h": "\(height)",
            "s": "\(Int(max(viewportScale, 1)))",
            "cap": "\(1 | 2 | 4 | 8 | 16)",
            "busy": isBusy ? "1" : "0",
            "pk": fingerprint,
            "ws": webSocketPath,
            "tls": "0"
        ]
    }

    private func fallbackVisibleText(for frame: SurfAceFrame) -> String {
        switch frame.payload {
        case .html(let html, _):
            let withoutStyleOrScript = html
                .replacingOccurrences(
                    of: "(?is)<style\\b[^>]*>.*?</style>",
                    with: " ",
                    options: .regularExpression
                )
                .replacingOccurrences(
                    of: "(?is)<script\\b[^>]*>.*?</script>",
                    with: " ",
                    options: .regularExpression
                )
            return withoutStyleOrScript.replacingOccurrences(of: "<[^>]+>", with: " ", options: .regularExpression)
        case .image(_, _, let alt):
            return alt ?? ""
        case .pdf(let data):
            return extractPDFText(base64Data: data)
        case .terminal(let lines, _):
            return lines.suffix(200).map(SurfAceANSI.strip).joined(separator: "\n")
        case .markdown(let markdown):
            return markdown
        }
    }

    private func defaultViewport() -> SurfAceViewport {
        let width = Double(max(viewportSize.width, 1))
        let height = Double(max(viewportSize.height, 1))
        return SurfAceViewport(
            scrollOffset: SurfAcePoint(x: 0, y: 0),
            visibleRect: SurfAceRect(x: 0, y: 0, width: width, height: height),
            contentSize: SurfAceSize(width: width, height: height),
            zoomLevel: 1
        )
    }

    private func validateFrame(_ frame: SurfAceFrame) -> (code: String, message: String)? {
        switch frame.payload {
        case .html:
            return nil
        case .image(let data, let mediaType, _):
            guard !mediaType.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                return ("invalid_payload", "mediaType is required")
            }
            guard let decoded = Data(base64Encoded: data, options: [.ignoreUnknownCharacters]) else {
                return ("invalid_payload", "image base64 decode failed")
            }
            if decoded.count > maxFrameBytes {
                return ("content_too_large", "frame content exceeds maxFrameBytes")
            }
        case .pdf(let data):
            guard let decoded = Data(base64Encoded: data, options: [.ignoreUnknownCharacters]) else {
                return ("invalid_payload", "pdf base64 decode failed")
            }
            if decoded.count > maxFrameBytes {
                return ("content_too_large", "frame content exceeds maxFrameBytes")
            }
        case .terminal(let lines, let scrollback):
            if scrollback < 0 {
                return ("invalid_payload", "terminal.scrollback must be >= 0")
            }
            let approximatePayloadBytes = lines.joined(separator: "\n").lengthOfBytes(using: .utf8)
            if approximatePayloadBytes > maxFrameBytes {
                return ("content_too_large", "frame content exceeds maxFrameBytes")
            }
        case .markdown(let markdown):
            if markdown.lengthOfBytes(using: .utf8) > maxFrameBytes {
                return ("content_too_large", "frame content exceeds maxFrameBytes")
            }
        }
        return nil
    }

    private func endSession(clearFrame shouldClearFrame: Bool) {
        if let session = activeSession {
            Task { await session.socket.close(code: 1000, reason: "provider_shutdown") }
        }
        activeSession = nil
        cancelResumeGrace()
        if shouldClearFrame {
            clearFrame()
        }
        refreshBonjourTXT()
    }

    private func clearFrame() {
        currentFrame = nil
        drawings.removeAll()
        pendingFlushStrokes.removeAll()
        clearPendingFlushState()
        lastReportedPDFPage = nil
        surfaceBridge?.render(frame: nil)
        surfaceBridge?.clearDrawings()
        refreshBonjourTXT()
    }

    private func decodeJSONObject(from text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) else {
            return nil
        }
        return object as? [String: Any]
    }

    private func jsonResponse(statusCode: Int, body: [String: Any]) -> HTTPServerResponse {
        guard let data = try? JSONSerialization.data(withJSONObject: body) else {
            return HTTPServerResponse(statusCode: 500)
        }
        return HTTPServerResponse(
            statusCode: statusCode,
            headers: ["Content-Type": "application/json"],
            body: data
        )
    }

    private func encodeJSON(_ object: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private func jsonObject(fromEncodable value: Encodable?) -> Any? {
        guard let value else { return nil }
        let encoder = JSONEncoder()
        guard let data = try? encoder.encode(AnyEncodable(value)),
              let object = try? JSONSerialization.jsonObject(with: data) else {
            return nil
        }
        return object
    }

    private func payloadHash(_ payload: [String: Any]) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]) else {
            return ""
        }
        let digest = SHA256.hash(data: data)
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    private func parseDrawingFlushConfig(_ object: [String: Any]?) -> SurfAceDrawingFlushConfig {
        guard let object else { return .default }
        let idle = parseInt(object["idleWindowMs"])
        let maxInterval = parseInt(object["maxIntervalMs"])
        return .from(requestedIdleWindowMs: idle, requestedMaxIntervalMs: maxInterval)
    }

    private func parseInt(_ value: Any?) -> Int? {
        if let intValue = value as? Int { return intValue }
        if let number = value as? NSNumber { return number.intValue }
        if let stringValue = value as? String { return Int(stringValue) }
        return nil
    }

    private func extractPDFText(base64Data: String) -> String {
        guard let decoded = Data(base64Encoded: base64Data, options: [.ignoreUnknownCharacters]),
              let document = PDFDocument(data: decoded) else {
            return ""
        }
        return document.string ?? ""
    }

    private func randomHex(prefix: String? = nil, byteCount: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: byteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, byteCount, &bytes)
        let hex: String
        if status == errSecSuccess {
            hex = bytes.map { String(format: "%02x", $0) }.joined()
        } else {
            hex = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        }

        if let prefix {
            return "\(prefix)_\(hex)"
        }
        return hex
    }

    private func timestampNow() -> Int64 {
        Int64(Date().timeIntervalSince1970 * 1000)
    }
}

private struct AnyEncodable: Encodable {
    private let encodeClosure: (Encoder) throws -> Void

    init(_ value: Encodable) {
        self.encodeClosure = value.encode
    }

    func encode(to encoder: Encoder) throws {
        try encodeClosure(encoder)
    }
}
