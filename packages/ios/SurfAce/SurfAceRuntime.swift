import CryptoKit
import Foundation
import Observation
import UIKit

private func surfAceServerRuntimeLog(_ message: String) {
    print("[SurfAce-Server] \(message)")
}

private func surfAceGatewayLog(_ message: String) {
    print("[SurfAce-Gateway] \(message)")
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
                    await drainQueue()
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

private struct SurfAceRequestReplayEntry {
    let payloadDigest: String
    let responseJSON: String
}

private struct SurfAcePairCommitPlan {
    let surfaceId: String
    let session: SurfAceSessionState
    let resumed: Bool
    let providerName: String?
    let providerInitialPaneId: Int
    let providerInitialPaneLabel: Int
    let providerWindowLabel: String
    let shouldEnqueuePostReconnectEvents: Bool
}

private struct SurfAceProcessedRequestResult {
    let responseObject: [String: Any]
    let postSendPairCommit: SurfAcePairCommitPlan?
}

private struct SurfAceSessionState {
    let sessionId: String
    let providerId: String
    let connectionId: String
    let connectionUUID: String
    let socket: SurfAceWebSocket
    let sender: SurfAceOutboundSender
    let eventProfile: SurfAceEventProfile
    let drawingFlushConfig: SurfAceDrawingFlushConfig
    let pairedAt: Date
    var pairConfirmed: Bool
}

private struct SurfAceOwnershipLockState {
    let sessionId: String
    let providerId: String
}

@MainActor
@Observable
final class SurfAceRuntime {
    private let fixedServerPort: UInt16 = 19_001
    var screenName: String
    var fingerprint: String
    var instanceDisambiguator: String
    var serverPort: Int = 0
    var endpointError: String?
    var surfaces: [SurfAceSurfaceModel] = []

    @ObservationIgnored private let server = SurfAceHTTPServer()
    @ObservationIgnored private let bonjourPublisher = SurfAceBonjourPublisher()
    @ObservationIgnored private let identityStore = SurfAceIdentityStore()
    @ObservationIgnored private let mappingStoreKey = "SurfAce.SurfaceIdentityMapping"
    @ObservationIgnored private var identity: SurfAceIdentity?
    @ObservationIgnored private var isStarted = false
    @ObservationIgnored private var surfaceById: [String: SurfAceSurfaceModel] = [:]
    @ObservationIgnored private var surfaceIdBySceneKey: [String: String] = [:]
    @ObservationIgnored private var activeSessions: [String: SurfAceSessionState] = [:]
    @ObservationIgnored private var lastHeartbeatAtBySurfaceId: [String: Date] = [:]
    @ObservationIgnored private var ownershipLocksBySurfaceId: [String: SurfAceOwnershipLockState] = [:]
    @ObservationIgnored private var ownershipLockOrphanedAt: [String: Date] = [:]
    @ObservationIgnored private var surfaceNeedsResumedEvent: Set<String> = []
    @ObservationIgnored private var terminatedConnectionUUIDs: Set<String> = []
    @ObservationIgnored private var identityMapping = SurfAceIdentityMapping()
    @ObservationIgnored private var heartbeatWatchdogTask: Task<Void, Never>?

    private let maxMessageBytes = 12 * 1024 * 1024
    private let maxFrameBytes = 10 * 1024 * 1024
    private let maxVisibleTextBytes = 4_096
    private let maxStrokePointsPerFlush = 8_192
    private let maxDrawingFlushBytes = 2 * 1024 * 1024
    private let resumeGraceMilliseconds = 20_000
    private let heartbeatTimeoutMilliseconds = 25_000
    private let heartbeatWatchdogCheckMilliseconds = 5_000
    private let ownershipLockExpiryMilliseconds = 60_000
    private let webSocketPath = "/ws"
    private let healthPath = "/health"
    private let supportedContentTypes: [SurfAceContentType] = [.html, .image, .pdf, .terminal, .markdown]
    private let eventTypes = [
        "event.drawing_flush",
        "event.annotation_committed",
        "event.tap",
        "event.scroll",
        "event.selection",
        "event.page",
        "event.navigation",
        "event.surface_appeared",
        "event.surface_removed",
        "event.surface_resumed",
        "event.snapshot_hint",
        "event.pane_created",
        "event.pane_removed",
        "event.pane_renamed",
    ]

    init() {
        let fallbackName = "Surf Ace"
        let deviceName = UIDevice.current.name
        let hostName = ProcessInfo.processInfo.hostName
        let shortHostName = hostName.split(separator: ".").first.map(String.init) ?? hostName
        self.screenName = "\(fallbackName) - \(deviceName) (\(shortHostName))"
        self.fingerprint = "00000000"
        let vendorID = UIDevice.current.identifierForVendor?
            .uuidString
            .replacingOccurrences(of: "-", with: "")
            .lowercased() ?? "0000"
        self.instanceDisambiguator = String(vendorID.prefix(6))

        do {
            let identity = try identityStore.loadOrCreateIdentity()
            self.identity = identity
            self.fingerprint = identity.fingerprint
        } catch {
            self.endpointError = "Identity init failed: \(error.localizedDescription)"
        }

        loadIdentityMapping()
        bonjourPublisher.onPublishFailure = { [weak self] details in
            Task { @MainActor in
                self?.endpointError = "Bonjour publish failed (\(details)); WS server remains available"
            }
        }
    }

    func start() async {
        guard !isStarted else { return }
        observeLifecycle()
        surfAceServerRuntimeLog("runtime start requested fixedPort=\(fixedServerPort) healthPath=\(healthPath) wsPath=\(webSocketPath)")

        do {
            let port = try await server.start(
                port: fixedServerPort,
                webSocketPath: webSocketPath,
                httpHandler: { [weak self] request in
                    guard let self else { return HTTPServerResponse(statusCode: 500) }
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
            surfAceServerRuntimeLog("runtime start succeeded port=\(serverPort) screenName=\(screenName) fingerprint=\(fingerprint)")
            startHeartbeatWatchdog()
            publishBonjour()
        } catch {
            surfAceServerRuntimeLog("runtime start failed port=\(fixedServerPort) error=\(error.localizedDescription)")
            endpointError = "Server failed on port \(fixedServerPort): \(error.localizedDescription)"
        }
    }

    func stop() async {
        surfAceServerRuntimeLog("runtime stop requested activeSessions=\(activeSessions.count) surfaces=\(surfaces.count)")
        heartbeatWatchdogTask?.cancel()
        heartbeatWatchdogTask = nil

        for surface in surfaces {
            for pane in surface.panes {
                pane.pendingFlushTask?.cancel()
                pane.pendingFlushTask = nil
            }
        }

        let sessions = activeSessions
        activeSessions.removeAll()
        lastHeartbeatAtBySurfaceId.removeAll()
        ownershipLocksBySurfaceId.removeAll()
        for (_, session) in sessions {
            await session.socket.close(code: 1000, reason: "provider_shutdown")
        }

        await server.stop()
        bonjourPublisher.stop()
        isStarted = false
        surfAceServerRuntimeLog("runtime stop completed")
    }

    func registerSurface(sceneKey: String) -> SurfAceSurfaceModel {
        if let existingSurfaceId = surfaceIdBySceneKey[sceneKey],
           let existing = surfaceById[existingSurfaceId] {
            return existing
        }

        let stored = identityMapping.surfacesBySceneKey[sceneKey]
        let surfaceId = stored?.surfaceId ?? randomHex(prefix: "sf", byteCount: 8)

        if stored == nil {
            identityMapping.surfacesBySceneKey[sceneKey] = StoredSurfaceIdentity(
                surfaceId: surfaceId
            )
            persistIdentityMapping()
        }

        let surface = SurfAceSurfaceModel(
            sceneKey: sceneKey,
            surfaceId: surfaceId,
            windowLabel: "",
            name: screenName
        )
        surfaceById[surfaceId] = surface
        surfaceIdBySceneKey[sceneKey] = surfaceId
        surfaces.append(surface)
        refreshConnectionState(surfaceId: surfaceId)
        refreshBonjourTXT()
        broadcastLifecycleEvent(
            op: "event.surface_appeared",
            payload: [
                "surfaceId": surface.surfaceId,
                "name": surface.name,
                "viewport": viewportPayload(for: surface),
            ]
        )
        return surface
    }

    func unregisterSurface(sceneKey: String) {
        guard let surfaceId = surfaceIdBySceneKey.removeValue(forKey: sceneKey),
              let surface = surfaceById.removeValue(forKey: surfaceId) else {
            return
        }

        surface.labelRestoreTask?.cancel()
        for pane in surface.panes {
            pane.pendingFlushTask?.cancel()
            pane.pendingFlushTask = nil
        }
        surfaces.removeAll { $0.surfaceId == surfaceId }

        broadcastLifecycleEvent(
            op: "event.surface_removed",
            payload: ["surfaceId": surfaceId]
        )

        if let session = activeSessions.removeValue(forKey: surfaceId) {
            lastHeartbeatAtBySurfaceId.removeValue(forKey: surfaceId)
            Task {
                await session.socket.close(code: 1000, reason: "surface_removed")
            }
        }
        ownershipLocksBySurfaceId.removeValue(forKey: surfaceId)
        refreshBonjourTXT()
    }

    func updateViewport(surfaceId: String, size: CGSize, scale: CGFloat) {
        guard let surface = surfaceById[surfaceId], size.width > 0, size.height > 0 else { return }
        surface.viewportSize = size
        surface.viewportScale = scale
        refreshBonjourTXT()
    }

    func attachPaneBridge(surfaceId: String, paneId: Int, bridge: any SurfAcePaneBridging) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        pane.bridge = bridge
        bridge.render(entry: pane.currentEntry.contentId == nil ? nil : pane.currentEntry)
        restorePaneDrawing(surfaceId: surfaceId, pane: pane)
        bridge.setInteraction(annotationMode: pane.annotationMode, fingerDrawEnabled: pane.fingerDrawEnabled)
    }

    func detachPaneBridge(surfaceId: String, paneId: Int) {
        pane(surfaceId: surfaceId, paneId: paneId)?.bridge = nil
    }

    func setAnnotationMode(surfaceId: String, paneId: Int, enabled: Bool, fingerDrawEnabled: Bool) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        let wasEnabled = pane.annotationMode
        pane.annotationMode = enabled
        pane.fingerDrawEnabled = enabled && fingerDrawEnabled
        pane.bridge?.setInteraction(annotationMode: pane.annotationMode, fingerDrawEnabled: pane.fingerDrawEnabled)
        noteInteraction(surfaceId: surfaceId)
        if wasEnabled && !enabled {
            requestAnnotationCommit(surfaceId: surfaceId, paneId: paneId)
        }
    }

    func toggleLabelsVisibility(surfaceId: String) {
        guard let surface = surfaceById[surfaceId] else { return }
        if surface.labelsVisible {
            noteInteraction(surfaceId: surfaceId)
        } else {
            surface.labelRestoreTask?.cancel()
            surface.labelsVisible = true
        }
    }

    func navigateHistory(surfaceId: String, paneId: Int, direction: HistoryDirection) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        guard !pane.annotationMode else {
            pane.toast = "Finish annotation (Done) to navigate"
            return
        }

        switch direction {
        case .back:
            guard let previous = pane.backStack.popLast() else { return }
            pane.forwardStack.append(pane.currentEntry)
            pane.currentEntry = previous
        case .forward:
            guard let next = pane.forwardStack.popLast() else { return }
            pane.backStack.append(pane.currentEntry)
            pane.currentEntry = next
        }

        pane.bridge?.render(entry: pane.currentEntry.contentId == nil ? nil : pane.currentEntry)
        restorePaneDrawing(surfaceId: surfaceId, pane: pane)
        pane.lastNavigationURL = pane.currentEntry.url
        noteInteraction(surfaceId: surfaceId)
    }

    func noteInteraction(surfaceId: String) {
        guard let surface = surfaceById[surfaceId] else { return }
        surface.labelsVisible = false
        surface.labelRestoreTask?.cancel()
        surface.labelRestoreTask = Task { [weak surface] in
            try? await Task.sleep(for: .seconds(1.5))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                surface?.labelsVisible = true
            }
        }
    }

    func clearToast(surfaceId: String, paneId: Int) {
        pane(surfaceId: surfaceId, paneId: paneId)?.toast = nil
    }

    func handleSelectionChanged(surfaceId: String, paneId: Int, text: String, rect: CGRect?) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId),
              let contentId = pane.currentEntry.contentId,
              let rect,
              !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              eventIsEnabled(surfaceId: surfaceId, eventName: "event.selection") else {
            return
        }

        let selection = SurfAceSelection.text(text.prefix(maxVisibleTextBytes).description, boundingRect: rect.surfAceRect)
        pane.lastSelection = selection
        sendEvent(
            surfaceId: surfaceId,
            op: "event.selection",
            payload: [
                "paneId": paneId,
                "contentId": contentId,
                "revision": pane.currentEntry.revision,
                "selection": jsonObject(fromEncodable: selection) ?? NSNull(),
            ]
        )
    }

    func handleScrollSettled(surfaceId: String, paneId: Int, viewport: SurfAceViewport, visibleText: String) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        pane.lastViewport = viewport
        pane.lastVisibleText = visibleText
        if eventIsEnabled(surfaceId: surfaceId, eventName: "event.scroll"),
           let contentId = pane.currentEntry.contentId {
            sendEvent(
                surfaceId: surfaceId,
                op: "event.scroll",
                payload: [
                    "paneId": paneId,
                    "contentId": contentId,
                    "revision": pane.currentEntry.revision,
                    "phase": "settled",
                    "viewport": jsonObject(fromEncodable: viewport) ?? NSNull(),
                    "visibleText": visibleText.prefix(maxVisibleTextBytes).description,
                ]
            )
        }
    }

    func handlePDFPageChanged(surfaceId: String, paneId: Int, page: Int, totalPages: Int, pageText: String?) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId),
              let contentId = pane.currentEntry.contentId else {
            return
        }

        let normalizedText = pageText?.prefix(maxVisibleTextBytes).description
        if pane.lastPage?.page == page, pane.lastPage?.totalPages == totalPages {
            pane.lastVisibleText = normalizedText ?? pane.lastVisibleText
            return
        }

        pane.lastPage = (page, totalPages, normalizedText)
        pane.lastVisibleText = normalizedText ?? ""
        guard eventIsEnabled(surfaceId: surfaceId, eventName: "event.page") else { return }

        sendEvent(
            surfaceId: surfaceId,
            op: "event.page",
            payload: [
                "paneId": paneId,
                "contentId": contentId,
                "revision": pane.currentEntry.revision,
                "page": page,
                "totalPages": totalPages,
                "pageText": jsonValue(normalizedText),
            ]
        )
    }

    func handleTapEvent(surfaceId: String, paneId: Int, kind: String, position: SurfAcePoint, nearestContent: String) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId),
              let contentId = pane.currentEntry.contentId,
              eventIsEnabled(surfaceId: surfaceId, eventName: "event.tap") else {
            return
        }

        sendEvent(
            surfaceId: surfaceId,
            op: "event.tap",
            payload: [
                "paneId": paneId,
                "contentId": contentId,
                "revision": pane.currentEntry.revision,
                "kind": kind == "long_press" ? "long_press" : "tap",
                "position": jsonObject(fromEncodable: position) ?? NSNull(),
                "nearestContent": nearestContent.prefix(maxVisibleTextBytes).description,
            ]
        )
    }

    func handleNavigationEvent(surfaceId: String, paneId: Int, url: String, sentAt: Int64?) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId),
              pane.currentEntry.contentType == .html,
              let contentId = pane.currentEntry.contentId,
              let normalized = normalizeURL(url) else {
            return
        }

        pane.currentEntry.url = normalized
        pane.lastNavigationURL = normalized
        sendEvent(
            surfaceId: surfaceId,
            op: "event.navigation",
            payload: [
                "paneId": paneId,
                "contentId": contentId,
                "revision": pane.currentEntry.revision,
                "url": normalized,
            ],
            sentAt: sentAt
        )
    }

    func handleNewStrokes(
        surfaceId: String,
        paneId: Int,
        strokes: [SurfAceStroke],
        drawingData: Data
    ) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId), !strokes.isEmpty else { return }
        noteInteraction(surfaceId: surfaceId)

        if !pane.annotationMode {
            pane.annotationMode = true
            pane.fingerDrawEnabled = false
            pane.bridge?.setInteraction(annotationMode: true, fingerDrawEnabled: false)
        }

        pane.currentEntry.drawingData = drawingData
        for stroke in strokes {
            pane.currentEntry.strokesById[stroke.strokeId] = stroke
            if let existingIndex = pane.pendingFlushStrokes.firstIndex(where: { $0.strokeId == stroke.strokeId }) {
                pane.pendingFlushStrokes[existingIndex] = stroke
            } else {
                pane.pendingFlushStrokes.append(stroke)
            }
        }

        let now = timestampNow()
        if pane.firstPendingStrokeAt == nil {
            pane.firstPendingStrokeAt = strokes.first?.points.first?.timestamp ?? now
        }
        pane.lastPendingStrokeAt = strokes.last?.points.last?.timestamp ?? now
        scheduleDrawingFlush(surfaceId: surfaceId, paneId: paneId)
    }

    enum HistoryDirection {
        case back
        case forward
    }

    private func observeLifecycle() {
        NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.handleDidEnterBackground()
            }
        }
        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: .main
        ) { [weak self] _ in
            Task { @MainActor in
                self?.handleWillEnterForeground()
            }
        }
    }

    private func handleDidEnterBackground() {
        let currentSessions = activeSessions
        for surfaceId in currentSessions.keys {
            surfaceNeedsResumedEvent.insert(surfaceId)
            surfaceById[surfaceId]?.connectionBarState = .connecting
        }
        for (_, session) in currentSessions {
            Task {
                await session.socket.close(code: 1000, reason: "background")
            }
        }
    }

    private func handleWillEnterForeground() {
        refreshBonjourTXT()
        for surfaceId in surfaceNeedsResumedEvent {
            refreshConnectionState(surfaceId: surfaceId)
        }
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
                    "busy": ownershipLocksBySurfaceId.isEmpty ? 0 : 1,
                    "surfaces": surfaces.map { surface in
                        [
                            "surfaceId": surface.surfaceId,
                            "name": surface.name,
                            "paired": ownershipLocksBySurfaceId[surface.surfaceId] != nil,
                        ]
                    },
                    "http": [
                        "healthPath": healthPath,
                        "upgradePath": webSocketPath,
                    ],
                    "ws": [
                        "version": 1,
                        "implementedOps": [
                            "surfaces.list",
                            "pair.request",
                            "content.set",
                            "content.append",
                            "content.patch",
                            "content.clear",
                            "annotations.remove",
                            "snapshot.get",
                            "heartbeat.ping",
                            "ownership.relinquish",
                            "panes.list",
                            "pane.split",
                            "pane.rename",
                            "pane.close",
                        ],
                    ],
                ]
            )
        }

        return jsonResponse(statusCode: 404, body: ["error": "not_found"])
    }

    private func handleWebSocket(_ socket: SurfAceWebSocket) async {
        let connectionUUID = randomHex(prefix: "cn", byteCount: 8)
        surfAceGatewayLog("socket opened connectionUUID=\(connectionUUID)")
        let sender = SurfAceOutboundSender(socket: socket)
        var replayCache: [String: SurfAceRequestReplayEntry] = [:]
        var replayOrder: [String] = []
        terminatedConnectionUUIDs.remove(connectionUUID)

        await socket.setCloseHandler { [weak self] in
            Task { @MainActor in
                await self?.handleSocketTermination(connectionUUID: connectionUUID)
            }
        }

        while true {
            do {
                guard let message = try await socket.receive() else {
                    await handleSocketTermination(connectionUUID: connectionUUID)
                    return
                }

                switch message {
                case .close:
                    surfAceGatewayLog("socket close frame received connectionUUID=\(connectionUUID)")
                    await handleSocketTermination(connectionUUID: connectionUUID)
                    return
                case .text(let text):
                    if text.lengthOfBytes(using: .utf8) > maxMessageBytes {
                        let errorResponse = makeErrorResponse(
                            op: "pair.request",
                            id: "oversize",
                            code: "content_too_large",
                            message: "message exceeds maxMessageBytes"
                        )
                        if let json = encodeJSON(errorResponse) {
                            try? await sender.send(text: json, priority: .response)
                        }
                        await socket.close(code: 4413, reason: "content_too_large")
                        await handleSocketTermination(connectionUUID: connectionUUID)
                        return
                    }

                    guard let requestObject = decodeJSONObject(from: text),
                          let type = requestObject["type"] as? String,
                          type == "request",
                          let op = requestObject["op"] as? String,
                          let id = requestObject["id"] as? String else {
                        surfAceGatewayLog("protocol violation connectionUUID=\(connectionUUID) invalid request envelope")
                        await socket.close(code: 4410, reason: "protocol_violation")
                        await handleSocketTermination(connectionUUID: connectionUUID)
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
                        if let json = encodeJSON(mismatch) {
                            try await sender.send(text: json, priority: .response)
                        }
                        continue
                    }

                    let processed = await processRequest(
                        op: op,
                        id: id,
                        payload: payload,
                        socket: socket,
                        sender: sender,
                        connectionUUID: connectionUUID
                    )
                    guard let responseJSON = encodeJSON(processed.responseObject) else {
                        await socket.close(code: 4500, reason: "internal_error")
                        await handleSocketTermination(connectionUUID: connectionUUID)
                        return
                    }

                    let priority: SurfAceOutboundSender.Priority = (op == "heartbeat.ping") ? .heartbeat : .response
                    try await sender.send(text: responseJSON, priority: priority)
                    if let pairCommit = processed.postSendPairCommit,
                       !terminatedConnectionUUIDs.contains(connectionUUID) {
                        commitPairRequest(pairCommit)
                    }
                    replayCache[id] = SurfAceRequestReplayEntry(payloadDigest: payloadDigest, responseJSON: responseJSON)
                    replayOrder.append(id)
                    if replayOrder.count > 1_024 {
                        replayCache.removeValue(forKey: replayOrder.removeFirst())
                    }
                    if op == "ownership.relinquish",
                       (processed.responseObject["ok"] as? Bool) == true {
                        await socket.close(code: 1000, reason: "relinquished")
                        return
                    }
                    if op == "pair.request",
                       (processed.responseObject["ok"] as? Bool) == false,
                       let error = processed.responseObject["error"] as? [String: Any],
                       let code = error["code"] as? String,
                       code == "missing_provider_name" {
                        await socket.close(code: 1008, reason: "missing_provider_name")
                        return
                    }
                }
            } catch {
                surfAceGatewayLog("socket loop failed connectionUUID=\(connectionUUID) error=\(error.localizedDescription)")
                await handleSocketTermination(connectionUUID: connectionUUID)
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
    ) async -> SurfAceProcessedRequestResult {
        switch op {
        case "surfaces.list":
            return SurfAceProcessedRequestResult(responseObject: handleSurfacesList(id: id), postSendPairCommit: nil)
        case "pair.request":
            return await handlePairRequest(
                id: id,
                payload: payload,
                socket: socket,
                sender: sender,
                connectionUUID: connectionUUID
            )
        case "panes.list":
            return SurfAceProcessedRequestResult(
                responseObject: handlePanesList(id: id, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "pane.split":
            return SurfAceProcessedRequestResult(
                responseObject: handlePaneSplit(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "pane.rename":
            return SurfAceProcessedRequestResult(
                responseObject: handlePaneRename(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "pane.close":
            return SurfAceProcessedRequestResult(
                responseObject: handlePaneClose(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "content.set":
            return SurfAceProcessedRequestResult(
                responseObject: await handleContentSet(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "content.append":
            return SurfAceProcessedRequestResult(
                responseObject: await handleContentAppend(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "content.patch":
            return SurfAceProcessedRequestResult(
                responseObject: await handleContentPatch(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "content.clear":
            return SurfAceProcessedRequestResult(
                responseObject: handleContentClear(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "annotations.remove":
            return SurfAceProcessedRequestResult(
                responseObject: handleAnnotationsRemove(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "snapshot.get":
            return SurfAceProcessedRequestResult(
                responseObject: await handleSnapshotGet(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "heartbeat.ping":
            return SurfAceProcessedRequestResult(
                responseObject: handleHeartbeatPing(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "ownership.relinquish":
            return SurfAceProcessedRequestResult(
                responseObject: handleOwnershipRelinquish(id: id, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        default:
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(op: op, id: id, code: "invalid_payload", message: "unsupported operation"),
                postSendPairCommit: nil
            )
        }
    }

    private func handleSurfacesList(id: String) -> [String: Any] {
        [
            "v": 1,
            "type": "response",
            "op": "surfaces.list",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "surfaces": surfaces.map { surface in
                    [
                        "surfaceId": surface.surfaceId,
                        "name": surface.name,
                        "viewport": viewportPayload(for: surface),
                        "paired": ownershipLocksBySurfaceId[surface.surfaceId] != nil,
                    ]
                },
            ],
        ]
    }

    private func handlePairRequest(
        id: String,
        payload: [String: Any],
        socket: SurfAceWebSocket,
        sender: SurfAceOutboundSender,
        connectionUUID: String
    ) async -> SurfAceProcessedRequestResult {
        let takeover = payload["takeover"] as? Bool ?? false
        let resumePayload = payload["resume"] as? [String: Any]
        let resumeSessionId = resumePayload?["sessionId"] as? String
        surfAceGatewayLog("pair.request received connectionUUID=\(connectionUUID) surfaceId=\(payload["surfaceId"] as? String ?? "nil") providerId=\(payload["providerId"] as? String ?? "nil") takeover=\(takeover) resumeSessionId=\(resumeSessionId ?? "nil")")
        guard let providerId = payload["providerId"] as? String,
              let connectionId = payload["connectionId"] as? String,
              let protocolVersion = payload["protocolVersion"] as? Int,
              let surfaceId = payload["surfaceId"] as? String,
              let surface = surfaceById[surfaceId] else {
            surfAceGatewayLog("pair.request invalid payload connectionUUID=\(connectionUUID)")
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(
                    op: "pair.request",
                    id: id,
                    code: "invalid_payload",
                    message: "providerId, connectionId, protocolVersion, surfaceId are required"
                ),
                postSendPairCommit: nil
            )
        }

        guard protocolVersion == 1 else {
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(
                    op: "pair.request",
                    id: id,
                    code: "unsupported_protocol_version",
                    message: "protocolVersion must be 1"
                ),
                postSendPairCommit: nil
            )
        }

        let eventProfile = SurfAceEventProfile(rawValue: payload["eventProfile"] as? String ?? "") ?? .minimumDeep
        let drawingConfigPayload = payload["drawingFlushConfig"] as? [String: Any]
        let drawingFlushConfig = SurfAceDrawingFlushConfig.from(
            requestedIdleWindowMs: drawingConfigPayload?["idleWindowMs"] as? Int,
            requestedMaxIntervalMs: drawingConfigPayload?["maxIntervalMs"] as? Int
        )
        guard let providerWindowLabel = normalizedWindowLabel(from: payload["windowLabel"]),
              let providerInitialPaneId = payload["initialPaneId"] as? Int,
              providerInitialPaneId > 0 else {
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(
                    op: "pair.request",
                    id: id,
                    code: "invalid_payload",
                    message: "windowLabel and initialPaneId are required"
                ),
                postSendPairCommit: nil
            )
        }
        let providerInitialPaneLabel = (payload["initialPaneLabel"] as? Int) ?? providerInitialPaneId
        guard providerInitialPaneLabel > 0 else {
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(
                    op: "pair.request",
                    id: id,
                    code: "invalid_payload",
                    message: "initialPaneLabel must be greater than zero"
                ),
                postSendPairCommit: nil
            )
        }
        guard let rawProviderName = payload["providerName"] as? String else {
            surfAceGatewayLog("pair.request missing providerName connectionUUID=\(connectionUUID)")
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(
                    op: "pair.request",
                    id: id,
                    code: "missing_provider_name",
                    message: "providerName is required"
                ),
                postSendPairCommit: nil
            )
        }
        let providerName = rawProviderName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !providerName.isEmpty else {
            surfAceGatewayLog("pair.request empty providerName connectionUUID=\(connectionUUID)")
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(
                    op: "pair.request",
                    id: id,
                    code: "missing_provider_name",
                    message: "providerName is required"
                ),
                postSendPairCommit: nil
            )
        }

        let activeSession = activeSessions[surfaceId]
        let ownershipLock = ownershipLocksBySurfaceId[surfaceId]
        let resumed: Bool
        let sessionId: String

        if let ownershipLock {
            if takeover {
                surfAceGatewayLog("pair.request takeover surfaceId=\(surfaceId) providerId=\(providerId)")
                resumed = false
                sessionId = randomHex(prefix: "sa", byteCount: 12)
                if let activeSession, activeSession.connectionUUID != connectionUUID {
                    Task {
                        await activeSession.socket.close(code: 1000, reason: "superseded")
                    }
                    activeSessions.removeValue(forKey: surfaceId)
                    lastHeartbeatAtBySurfaceId.removeValue(forKey: surfaceId)
                }
            } else if ownershipLock.providerId == providerId {
                guard resumeSessionId == ownershipLock.sessionId else {
                    surfAceGatewayLog("pair.request invalid_resume surfaceId=\(surfaceId) providerId=\(providerId) expectedSessionId=\(ownershipLock.sessionId) receivedSessionId=\(resumeSessionId ?? "nil")")
                    return SurfAceProcessedRequestResult(
                        responseObject: makeErrorResponse(
                            op: "pair.request",
                            id: id,
                            code: "invalid_resume",
                            message: "Resume session did not match active ownership lock"
                        ),
                        postSendPairCommit: nil
                    )
                }
                resumed = true
                sessionId = ownershipLock.sessionId
                surfAceGatewayLog("pair.request resumed surfaceId=\(surfaceId) providerId=\(providerId) sessionId=\(sessionId)")
                if let activeSession, activeSession.connectionUUID != connectionUUID {
                    Task {
                        await activeSession.socket.close(code: 1000, reason: "superseded")
                    }
                    activeSessions.removeValue(forKey: surfaceId)
                    lastHeartbeatAtBySurfaceId.removeValue(forKey: surfaceId)
                }
            } else {
                surfAceGatewayLog("pair.request busy surfaceId=\(surfaceId) requestedProviderId=\(providerId) lockProviderId=\(ownershipLock.providerId)")
                return SurfAceProcessedRequestResult(
                    responseObject: makeErrorResponse(
                        op: "pair.request",
                        id: id,
                        code: "busy",
                        message: "surface ownership lock is held by another provider"
                    ),
                    postSendPairCommit: nil
                )
            }
        } else {
            resumed = false
            sessionId = randomHex(prefix: "sa", byteCount: 12)
            surfAceGatewayLog("pair.request new session surfaceId=\(surfaceId) providerId=\(providerId) sessionId=\(sessionId)")
        }

        let session = SurfAceSessionState(
            sessionId: sessionId,
            providerId: providerId,
            connectionId: connectionId,
            connectionUUID: connectionUUID,
            socket: socket,
            sender: sender,
            eventProfile: eventProfile,
            drawingFlushConfig: drawingFlushConfig,
            pairedAt: Date(),
            pairConfirmed: false
        )

        let response: [String: Any] = [
            "v": 1,
            "type": "response",
            "op": "pair.request",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "sessionId": sessionId,
                "resumed": resumed,
                "surfaceId": surface.surfaceId,
                "surfaceName": surface.name,
                "viewport": viewportPayload(for: surface),
                "capabilities": [
                    "contentTypes": supportedContentTypes.map(\.rawValue),
                    "eventTypes": eventTypes,
                ],
                "eventConfig": [
                    "profile": eventProfile.rawValue,
                    "activeEvents": eventProfile.activeEvents,
                    "drawingFlushConfig": [
                        "idleWindowMs": drawingFlushConfig.idleWindowMs,
                        "maxIntervalMs": drawingFlushConfig.maxIntervalMs,
                    ],
                ],
                "limits": [
                    "maxMessageBytes": maxMessageBytes,
                    "maxFrameBytes": maxFrameBytes,
                    "maxVisibleTextBytes": maxVisibleTextBytes,
                    "maxStrokePointsPerFlush": maxStrokePointsPerFlush,
                    "maxDrawingFlushBytes": maxDrawingFlushBytes,
                    "resumeGraceMs": resumeGraceMilliseconds,
                ],
                "state": [
                    "panes": surface.panes.map { pane in
                        [
                            "paneId": pane.paneId,
                            "paneLabel": pane.paneLabel,
                            "currentContentId": jsonValue(pane.currentEntry.contentId),
                            "currentRevision": pane.currentEntry.revision,
                            "contentType": jsonValue(pane.currentEntry.contentType?.rawValue),
                        ]
                    },
                ],
            ],
        ]

        return SurfAceProcessedRequestResult(
            responseObject: response,
            postSendPairCommit: SurfAcePairCommitPlan(
                surfaceId: surfaceId,
                session: session,
                resumed: resumed,
                providerName: providerName,
                providerInitialPaneId: providerInitialPaneId,
                providerInitialPaneLabel: providerInitialPaneLabel,
                providerWindowLabel: providerWindowLabel,
                shouldEnqueuePostReconnectEvents: resumed || surfaceNeedsResumedEvent.contains(surfaceId)
            )
        )
    }

    private func commitPairRequest(_ plan: SurfAcePairCommitPlan) {
        guard let surface = surfaceById[plan.surfaceId] else { return }
        surfAceGatewayLog("pair committed surfaceId=\(plan.surfaceId) providerId=\(plan.session.providerId) sessionId=\(plan.session.sessionId) resumed=\(plan.resumed)")
        if !plan.resumed {
            applyProviderBootstrapTopology(
                surface: surface,
                windowLabel: plan.providerWindowLabel,
                initialPaneId: plan.providerInitialPaneId,
                initialPaneLabel: plan.providerInitialPaneLabel
            )
        }
        activeSessions[plan.surfaceId] = plan.session
        surface.providerName = plan.providerName
        ownershipLocksBySurfaceId[plan.surfaceId] = SurfAceOwnershipLockState(
            sessionId: plan.session.sessionId,
            providerId: plan.session.providerId
        )
        lastHeartbeatAtBySurfaceId[plan.surfaceId] = Date()
        ownershipLockOrphanedAt.removeValue(forKey: plan.surfaceId)
        refreshConnectionState(surfaceId: plan.surfaceId)
        reschedulePendingFlushes(surfaceId: plan.surfaceId)
        refreshBonjourTXT()

        if plan.shouldEnqueuePostReconnectEvents {
            surfaceNeedsResumedEvent.remove(plan.surfaceId)
            enqueuePostReconnectEvents(surfaceId: plan.surfaceId)
        }
    }

    private func handlePanesList(id: String, connectionUUID: String) -> [String: Any] {
        guard let (surfaceId, surface) = pairedSurface(for: connectionUUID) else {
            return makeErrorResponse(op: "panes.list", id: id, code: "not_paired", message: "pair.request required")
        }

        return [
            "v": 1,
            "type": "response",
            "op": "panes.list",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "panes": surface.panes.map { pane in
                    [
                        "paneId": pane.paneId,
                        "paneLabel": pane.paneLabel,
                        "name": jsonValue(pane.name),
                        "activeContentId": jsonValue(pane.currentEntry.contentId),
                        "contentType": jsonValue(pane.currentEntry.contentType?.rawValue),
                        "viewport": paneViewportPayload(surfaceId: surfaceId, paneId: pane.paneId),
                    ]
                },
            ],
        ]
    }

    private func handlePaneSplit(id: String, payload: [String: Any], connectionUUID: String) -> [String: Any] {
        guard let (surfaceId, surface) = pairedSurface(for: connectionUUID) else {
            return makeErrorResponse(op: "pane.split", id: id, code: "not_paired", message: "pair.request required")
        }

        guard let paneId = payload["paneId"] as? Int,
              let count = payload["count"] as? Int,
              let directionRaw = payload["direction"] as? String,
              let direction = SurfAceLayoutDirection(rawValue: directionRaw),
              let newPaneIds = payload["newPaneIds"] as? [Int],
              count >= 2,
              newPaneIds.count == count - 1,
              let _ = surface.panesById[paneId] else {
            return makeErrorResponse(op: "pane.split", id: id, code: "invalid_payload", message: "invalid pane.split payload")
        }
        let newPaneLabels = (payload["newPaneLabels"] as? [Int]) ?? newPaneIds
        guard newPaneLabels.count == count - 1 else {
            return makeErrorResponse(op: "pane.split", id: id, code: "invalid_payload", message: "invalid pane.split payload")
        }

        for newPaneId in newPaneIds where surface.panesById[newPaneId] != nil {
            return makeErrorResponse(op: "pane.split", id: id, code: "invalid_payload", message: "newPaneIds must be unique")
        }

        let children: [SurfAcePaneLayoutNode] = [.leaf(paneId)] + newPaneIds.map(SurfAcePaneLayoutNode.leaf)
        surface.paneLayout = surface.paneLayout.replacingLeaf(
            paneId: paneId,
            with: .split(direction: direction, children: children)
        )

        for (index, newPaneId) in newPaneIds.enumerated() {
            let newPaneLabel = newPaneLabels[index]
            surface.panesById[newPaneId] = SurfAcePaneModel(paneId: newPaneId, paneLabel: newPaneLabel)
            sendLifecycleEvent(
                surfaceId: surfaceId,
                op: "event.pane_created",
                payload: [
                    "surfaceId": surfaceId,
                    "paneId": newPaneId,
                    "paneLabel": newPaneLabel,
                    "parentPaneId": paneId,
                    "fromSplit": true,
                ]
            )
        }

        return [
            "v": 1,
            "type": "response",
            "op": "pane.split",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "panes": surface.panes.map { ["paneId": $0.paneId, "paneLabel": $0.paneLabel] },
            ],
        ]
    }

    private func handlePaneRename(id: String, payload: [String: Any], connectionUUID: String) -> [String: Any] {
        guard let (surfaceId, _) = pairedSurface(for: connectionUUID),
              let paneId = payload["paneId"] as? Int,
              let pane = pane(surfaceId: surfaceId, paneId: paneId) else {
            return makeErrorResponse(op: "pane.rename", id: id, code: "invalid_payload", message: "paneId is required")
        }

        let name = payload["name"] as? String
        pane.name = name?.isEmpty == true ? nil : name
        sendLifecycleEvent(
            surfaceId: surfaceId,
            op: "event.pane_renamed",
            payload: [
                "surfaceId": surfaceId,
                "paneId": paneId,
                "name": jsonValue(pane.name),
            ]
        )

        return [
            "v": 1,
            "type": "response",
            "op": "pane.rename",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "paneId": paneId,
                "name": jsonValue(pane.name),
            ],
        ]
    }

    private func handlePaneClose(id: String, payload: [String: Any], connectionUUID: String) -> [String: Any] {
        guard let (surfaceId, surface) = pairedSurface(for: connectionUUID),
              let paneId = payload["paneId"] as? Int,
              surface.panes.count > 1,
              let pane = pane(surfaceId: surfaceId, paneId: paneId) else {
            return makeErrorResponse(op: "pane.close", id: id, code: "invalid_operation", message: "cannot close pane")
        }

        let closedFramesDiscarded = pane.deliveredClosedFrameCount
        pane.pendingFlushTask?.cancel()
        pane.pendingFlushTask = nil
        surface.panesById.removeValue(forKey: paneId)
        if let newLayout = surface.paneLayout.removingLeaf(paneId: paneId) {
            surface.paneLayout = newLayout
        }

        sendLifecycleEvent(
            surfaceId: surfaceId,
            op: "event.pane_removed",
            payload: [
                "surfaceId": surfaceId,
                "paneId": paneId,
            ]
        )

        return [
            "v": 1,
            "type": "response",
            "op": "pane.close",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "paneId": paneId,
                "closedFramesDiscarded": closedFramesDiscarded,
            ],
        ]
    }

    private func handleContentSet(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard let (surfaceId, _) = pairedSurface(for: connectionUUID),
              let paneId = payload["paneId"] as? Int,
              let pane = pane(surfaceId: surfaceId, paneId: paneId),
              let contentId = payload["contentId"] as? String,
              let revision = payload["revision"] as? Int else {
            return makeErrorResponse(op: "content.set", id: id, code: "invalid_payload", message: "paneId, contentId, revision are required")
        }

        guard revision == pane.currentEntry.revision + 1 else {
            return staleRevisionResponse(op: "content.set", id: id, expectedRevision: pane.currentEntry.revision + 1)
        }
        guard !pane.annotationMode else {
            pane.toast = "Finish annotation (Done) to navigate"
            return makeErrorResponse(op: "content.set", id: id, code: "invalid_operation", message: "annotation mode is active")
        }
        guard payloadByteCount(payload) <= maxFrameBytes else {
            return makeErrorResponse(op: "content.set", id: id, code: "content_too_large", message: "content exceeds maxFrameBytes")
        }

        let frame: SurfAceFrame
        do {
            frame = try SurfAceFrame.from(contentId: contentId, revision: revision, jsonObject: payload)
        } catch SurfAceFrameParseError.unsupportedType {
            return makeErrorResponse(op: "content.set", id: id, code: "unsupported_content_type", message: "unsupported contentType")
        } catch SurfAceFrameParseError.invalidContentID {
            return makeErrorResponse(op: "content.set", id: id, code: "invalid_payload", message: "contentId must match ct_<8hex>")
        } catch SurfAceFrameParseError.missingField(let field) {
            return makeErrorResponse(op: "content.set", id: id, code: "invalid_payload", message: "missing \(field)")
        } catch {
            return makeErrorResponse(op: "content.set", id: id, code: "invalid_payload", message: "invalid content.set payload")
        }

        if frame.contentType == .canvas {
            return makeErrorResponse(op: "content.set", id: id, code: "unsupported_content_type", message: "unsupported contentType")
        }

        guard let historyOwnerToken = normalizedHistoryOwnerToken(from: payload["historyOwnerToken"]) else {
            return makeErrorResponse(op: "content.set", id: id, code: "invalid_payload", message: "historyOwnerToken is required")
        }
        let historyInfo = applyContentSet(frame: frame, to: pane, historyOwnerToken: historyOwnerToken)

        pane.pendingFlushStrokes.removeAll()
        pane.firstPendingStrokeAt = nil
        pane.lastPendingStrokeAt = nil
        pane.lastSelection = nil
        pane.lastNavigationURL = nil
        pane.lastPage = nil
        pane.bridge?.render(entry: pane.currentEntry)
        restorePaneDrawing(surfaceId: surfaceId, pane: pane)
        sendSnapshotHint(surfaceId: surfaceId, reason: "after_render")

        return mutationAck(
            id: id,
            op: "content.set",
            paneId: paneId,
            entry: pane.currentEntry,
            historyInfo: historyInfo
        )
    }

    private func handleContentAppend(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard let (surfaceId, _) = pairedSurface(for: connectionUUID),
              let paneId = payload["paneId"] as? Int,
              let pane = pane(surfaceId: surfaceId, paneId: paneId),
              let contentId = payload["contentId"] as? String,
              let revision = payload["revision"] as? Int,
              let lines = payload["lines"] as? [String] else {
            return makeErrorResponse(op: "content.append", id: id, code: "invalid_payload", message: "invalid content.append payload")
        }

        guard !pane.annotationMode else {
            pane.toast = "Finish annotation (Done) to navigate"
            return makeErrorResponse(op: "content.append", id: id, code: "invalid_operation", message: "annotation mode is active")
        }
        guard pane.currentEntry.contentId == contentId else {
            return makeErrorResponse(op: "content.append", id: id, code: "stale_content", message: "contentId is not current")
        }
        guard revision == pane.currentEntry.revision + 1 else {
            return staleRevisionResponse(op: "content.append", id: id, expectedRevision: pane.currentEntry.revision + 1)
        }
        guard case .terminal(let existingLines, let scrollback) = pane.currentEntry.payload else {
            return makeErrorResponse(op: "content.append", id: id, code: "unsupported_operation_for_content_type", message: "append is terminal-only")
        }

        let nextLines = existingLines + lines
        let nextPayload = SurfAceFramePayload.terminal(lines: nextLines, scrollback: scrollback)
        pane.currentEntry.payload = nextPayload
        pane.currentEntry.revision = revision
        pane.bridge?.render(entry: pane.currentEntry)

        return mutationAck(id: id, op: "content.append", paneId: paneId, entry: pane.currentEntry)
    }

    private func handleContentPatch(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard let (surfaceId, _) = pairedSurface(for: connectionUUID),
              let paneId = payload["paneId"] as? Int,
              let pane = pane(surfaceId: surfaceId, paneId: paneId),
              let contentId = payload["contentId"] as? String,
              let revision = payload["revision"] as? Int,
              let patchObject = payload["patch"] as? [String: Any],
              let selector = patchObject["selector"] as? String,
              let action = patchObject["action"] as? String else {
            return makeErrorResponse(op: "content.patch", id: id, code: "invalid_payload", message: "invalid content.patch payload")
        }

        guard !pane.annotationMode else {
            pane.toast = "Finish annotation (Done) to navigate"
            return makeErrorResponse(op: "content.patch", id: id, code: "invalid_operation", message: "annotation mode is active")
        }
        guard pane.currentEntry.contentId == contentId else {
            return makeErrorResponse(op: "content.patch", id: id, code: "stale_content", message: "contentId is not current")
        }
        guard revision == pane.currentEntry.revision + 1 else {
            return staleRevisionResponse(op: "content.patch", id: id, expectedRevision: pane.currentEntry.revision + 1)
        }
        guard case .html(_, let baseURL) = pane.currentEntry.payload else {
            return makeErrorResponse(op: "content.patch", id: id, code: "unsupported_operation_for_content_type", message: "patch is html-only")
        }
        guard let bridge = pane.bridge else {
            return makeErrorResponse(op: "content.patch", id: id, code: "render_failed", message: "pane renderer unavailable")
        }

        let patch = SurfAceFramePatchRequest(
            contentId: contentId,
            selector: selector,
            action: action,
            html: patchObject["html"] as? String
        )

        switch await bridge.applyHTMLPatch(patch) {
        case .success(let updatedHTML):
            pane.currentEntry.payload = .html(html: updatedHTML, baseURL: baseURL)
            pane.currentEntry.revision = revision
            return mutationAck(id: id, op: "content.patch", paneId: paneId, entry: pane.currentEntry)
        case .selectorNotFound:
            return makeErrorResponse(op: "content.patch", id: id, code: "render_failed", message: "patch selector did not match any element")
        case .invalidAction:
            return makeErrorResponse(op: "content.patch", id: id, code: "render_failed", message: "patch action is not supported")
        case .failed(let message):
            return makeErrorResponse(op: "content.patch", id: id, code: "render_failed", message: message)
        }
    }

    private func handleContentClear(id: String, payload: [String: Any], connectionUUID: String) -> [String: Any] {
        guard let (surfaceId, _) = pairedSurface(for: connectionUUID),
              let paneId = payload["paneId"] as? Int,
              let pane = pane(surfaceId: surfaceId, paneId: paneId),
              let revision = payload["revision"] as? Int else {
            return makeErrorResponse(op: "content.clear", id: id, code: "invalid_payload", message: "paneId and revision are required")
        }

        guard revision == pane.currentEntry.revision + 1 else {
            return staleRevisionResponse(op: "content.clear", id: id, expectedRevision: pane.currentEntry.revision + 1)
        }
        guard !pane.annotationMode else {
            pane.toast = "Finish annotation (Done) to navigate"
            return makeErrorResponse(op: "content.clear", id: id, code: "invalid_operation", message: "annotation mode is active")
        }

        if pane.currentEntry.contentId != nil {
            pane.backStack.append(pane.currentEntry)
            if pane.backStack.count > 20 {
                pane.backStack.removeFirst(pane.backStack.count - 20)
            }
        }
        pane.forwardStack.removeAll()
        pane.currentEntry = .empty(revision: revision)
        pane.drawingRestoreWarningVisible = false
        pane.pendingFlushStrokes.removeAll()
        pane.firstPendingStrokeAt = nil
        pane.lastPendingStrokeAt = nil
        pane.bridge?.render(entry: nil)
        pane.bridge?.clearDrawings()

        return mutationAck(id: id, op: "content.clear", paneId: paneId, entry: pane.currentEntry)
    }

    private func handleAnnotationsRemove(id: String, payload: [String: Any], connectionUUID: String) -> [String: Any] {
        guard let (surfaceId, _) = pairedSurface(for: connectionUUID),
              let paneId = payload["paneId"] as? Int,
              let pane = pane(surfaceId: surfaceId, paneId: paneId),
              let contentId = payload["contentId"] as? String,
              let strokeIds = payload["strokeIds"] as? [String] else {
            return makeErrorResponse(op: "annotations.remove", id: id, code: "invalid_payload", message: "paneId, contentId, strokeIds are required")
        }

        guard pane.currentEntry.contentId == contentId else {
            return makeErrorResponse(op: "annotations.remove", id: id, code: "stale_content", message: "contentId is not current")
        }

        var removed: [String] = []
        var notFound: [String] = []
        for strokeId in strokeIds {
            if pane.currentEntry.strokesById.removeValue(forKey: strokeId) != nil {
                removed.append(strokeId)
                pane.pendingFlushStrokes.removeAll { $0.strokeId == strokeId }
            } else {
                notFound.append(strokeId)
            }
        }

        pane.bridge?.removeDrawingStrokeIDs(removed)
        pane.currentEntry.drawingData = pane.bridge?.captureDrawingData() ?? Data()

        return [
            "v": 1,
            "type": "response",
            "op": "annotations.remove",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "paneId": paneId,
                "contentId": contentId,
                "removedStrokeIds": removed,
                "notFoundStrokeIds": notFound,
                "remainingStrokeCount": pane.currentEntry.strokesById.count,
            ],
        ]
    }

    private func handleSnapshotGet(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard let (surfaceId, _) = pairedSurface(for: connectionUUID),
              let paneId = payload["paneId"] as? Int,
              let pane = pane(surfaceId: surfaceId, paneId: paneId) else {
            return makeErrorResponse(op: "snapshot.get", id: id, code: "invalid_payload", message: "paneId is required")
        }

        let includeImage = payload["includeImage"] as? Bool ?? false
        let includeVisibleText = payload["includeVisibleText"] as? Bool ?? true
        let includeDrawings = payload["includeDrawings"] as? Bool ?? false
        let snapshot = await pane.bridge?.fetchSnapshot(includeImage: includeImage)

        pane.lastViewport = snapshot?.viewport ?? defaultViewport(surface: surfaceById[surfaceId])
        if let visibleText = snapshot?.visibleText {
            pane.lastVisibleText = visibleText
        }
        pane.lastSelection = snapshot?.selection ?? pane.lastSelection

        var responsePayload: [String: Any] = [
            "paneId": paneId,
            "contentId": jsonValue(pane.currentEntry.contentId),
            "revision": pane.currentEntry.revision,
            "contentType": jsonValue(pane.currentEntry.contentType?.rawValue),
            "viewport": jsonObject(fromEncodable: pane.lastViewport) ?? NSNull(),
            "selection": jsonObject(fromEncodable: pane.lastSelection) ?? NSNull(),
        ]
        if includeVisibleText {
            responsePayload["visibleText"] = pane.lastVisibleText.prefix(maxVisibleTextBytes).description
        }
        if includeDrawings {
            responsePayload["drawings"] = jsonObject(fromEncodable: pane.activeStrokes) ?? []
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
            "payload": responsePayload,
        ]
    }

    private func handleHeartbeatPing(id: String, payload: [String: Any], connectionUUID: String) -> [String: Any] {
        guard let (surfaceId, _) = pairedSurface(for: connectionUUID) else {
            return makeErrorResponse(op: "heartbeat.ping", id: id, code: "not_paired", message: "pair.request required")
        }
        guard let nonce = payload["nonce"] as? String else {
            return makeErrorResponse(op: "heartbeat.ping", id: id, code: "invalid_payload", message: "nonce is required")
        }
        lastHeartbeatAtBySurfaceId[surfaceId] = Date()
        if var session = activeSessions[surfaceId],
           !session.pairConfirmed {
            session.pairConfirmed = true
            activeSessions[surfaceId] = session
            refreshConnectionState(surfaceId: surfaceId)
        }

        return [
            "v": 1,
            "type": "response",
            "op": "heartbeat.ping",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": ["nonce": nonce],
        ]
    }

    private func handleOwnershipRelinquish(id: String, connectionUUID: String) -> [String: Any] {
        guard let (surfaceId, _) = pairedSurface(for: connectionUUID),
              let activeSession = activeSessions[surfaceId],
              let ownershipLock = ownershipLocksBySurfaceId[surfaceId] else {
            return makeErrorResponse(
                op: "ownership.relinquish",
                id: id,
                code: "not_paired",
                message: "pair.request required"
            )
        }
        guard activeSession.connectionUUID == connectionUUID,
              ownershipLock.providerId == activeSession.providerId else {
            return makeErrorResponse(
                op: "ownership.relinquish",
                id: id,
                code: "not_lock_owner",
                message: "Only the current lock owner may relinquish ownership"
            )
        }

        ownershipLocksBySurfaceId.removeValue(forKey: surfaceId)
        ownershipLockOrphanedAt.removeValue(forKey: surfaceId)
        activeSessions.removeValue(forKey: surfaceId)
        lastHeartbeatAtBySurfaceId.removeValue(forKey: surfaceId)
        surfaceNeedsResumedEvent.remove(surfaceId)
        surfaceById[surfaceId]?.providerName = nil
        refreshConnectionState(surfaceId: surfaceId)
        refreshBonjourTXT()

        return [
            "v": 1,
            "type": "response",
            "op": "ownership.relinquish",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "relinquished": true,
            ],
        ]
    }

    private func pairedSurface(for connectionUUID: String) -> (String, SurfAceSurfaceModel)? {
        guard let pair = activeSessions.first(where: { $0.value.connectionUUID == connectionUUID }),
              let surface = surfaceById[pair.key] else {
            return nil
        }
        return (pair.key, surface)
    }

    private func handleSocketTermination(connectionUUID: String) async {
        terminatedConnectionUUIDs.insert(connectionUUID)
        guard let pair = activeSessions.first(where: { $0.value.connectionUUID == connectionUUID }) else { return }
        let surfaceId = pair.key
        surfAceGatewayLog("socket terminated connectionUUID=\(connectionUUID) surfaceId=\(surfaceId) providerId=\(pair.value.providerId) sessionId=\(pair.value.sessionId)")
        activeSessions.removeValue(forKey: surfaceId)
        lastHeartbeatAtBySurfaceId.removeValue(forKey: surfaceId)
        surfaceById[surfaceId]?.providerName = nil
        // Track when the ownership lock became orphaned (session gone, lock stays
        // for resume support).  The heartbeat watchdog will expire the lock if no
        // new session arrives within ownershipLockExpiryMilliseconds.
        if ownershipLocksBySurfaceId[surfaceId] != nil {
            ownershipLockOrphanedAt[surfaceId] = Date()
        }
        refreshConnectionState(surfaceId: surfaceId)
        refreshBonjourTXT()
    }

    private func startHeartbeatWatchdog() {
        heartbeatWatchdogTask?.cancel()
        heartbeatWatchdogTask = Task { [weak self] in
            while let self, !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(self.heartbeatWatchdogCheckMilliseconds))
                guard !Task.isCancelled else { return }
                await MainActor.run {
                    self.expireStaleSessionsForHeartbeat()
                    self.expireOrphanedOwnershipLocks()
                }
            }
        }
    }

    private func expireStaleSessionsForHeartbeat() {
        guard !activeSessions.isEmpty else { return }
        let now = Date()
        var expired: [(surfaceId: String, session: SurfAceSessionState)] = []

        for (surfaceId, session) in activeSessions {
            let lastHeartbeatAt = lastHeartbeatAtBySurfaceId[surfaceId] ?? session.pairedAt
            let ageMilliseconds = now.timeIntervalSince(lastHeartbeatAt) * 1000
            if ageMilliseconds > Double(heartbeatTimeoutMilliseconds) {
                expired.append((surfaceId, session))
            }
        }

        guard !expired.isEmpty else { return }

        for expiredSession in expired {
            activeSessions.removeValue(forKey: expiredSession.surfaceId)
            lastHeartbeatAtBySurfaceId.removeValue(forKey: expiredSession.surfaceId)
            surfaceById[expiredSession.surfaceId]?.providerName = nil
            refreshConnectionState(surfaceId: expiredSession.surfaceId)
            Task {
                await expiredSession.session.socket.close(code: 1000, reason: "heartbeat_timeout")
            }
        }
        refreshBonjourTXT()
    }

    private func expireOrphanedOwnershipLocks() {
        guard !ownershipLockOrphanedAt.isEmpty else { return }
        let now = Date()
        var expiredSurfaceIds: [String] = []
        var reconciledSurfaceIds: [String] = []

        for (surfaceId, orphanedAt) in ownershipLockOrphanedAt {
            // If a session was re-established, the orphan record is stale.
            guard activeSessions[surfaceId] == nil else {
                reconciledSurfaceIds.append(surfaceId)
                continue
            }
            let ageMilliseconds = now.timeIntervalSince(orphanedAt) * 1000
            if ageMilliseconds > Double(ownershipLockExpiryMilliseconds) {
                expiredSurfaceIds.append(surfaceId)
            }
        }

        for surfaceId in reconciledSurfaceIds {
            ownershipLockOrphanedAt.removeValue(forKey: surfaceId)
        }

        guard !expiredSurfaceIds.isEmpty else { return }

        for surfaceId in expiredSurfaceIds {
            ownershipLocksBySurfaceId.removeValue(forKey: surfaceId)
            ownershipLockOrphanedAt.removeValue(forKey: surfaceId)
            surfaceById[surfaceId]?.providerName = nil
            refreshConnectionState(surfaceId: surfaceId)
        }
        refreshBonjourTXT()
    }

    private func refreshConnectionState(surfaceId: String) {
        guard let surface = surfaceById[surfaceId] else { return }
        if hasLiveActiveSession(surfaceId: surfaceId) {
            surface.connectionBarState = .connected
        } else if ownershipLocksBySurfaceId[surfaceId] != nil {
            surface.connectionBarState = .connecting
        } else {
            surface.connectionBarState = .disconnected
            surface.providerName = nil
        }
    }

    private func hasLiveActiveSession(surfaceId: String) -> Bool {
        guard let session = activeSessions[surfaceId],
              let ownershipLock = ownershipLocksBySurfaceId[surfaceId] else {
            return false
        }
        return session.pairConfirmed
            && ownershipLock.providerId == session.providerId
            && ownershipLock.sessionId == session.sessionId
    }

    private func mutationAck(
        id: String,
        op: String,
        paneId: Int,
        entry: SurfAcePaneEntry,
        historyInfo: [String: Any]? = nil
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "paneId": paneId,
            "currentContentId": jsonValue(entry.contentId),
            "currentRevision": entry.revision,
            "contentType": jsonValue(entry.contentType?.rawValue),
            "contentId": jsonValue(entry.contentId),
        ]
        historyInfo?.forEach { payload[$0.key] = $0.value }

        return [
            "v": 1,
            "type": "response",
            "op": op,
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": payload,
        ]
    }

    private func staleRevisionResponse(op: String, id: String, expectedRevision: Int) -> [String: Any] {
        makeErrorResponse(
            op: op,
            id: id,
            code: "stale_revision",
            message: "revision mismatch",
            details: ["expectedRevision": expectedRevision]
        )
    }

    private func sendEvent(surfaceId: String, op: String, payload: [String: Any], sentAt: Int64? = nil) {
        Task {
            _ = await sendEventAsync(surfaceId: surfaceId, op: op, payload: payload, sentAt: sentAt)
        }
    }

    private func sendEventAsync(
        surfaceId: String,
        op: String,
        payload: [String: Any],
        sentAt: Int64? = nil
    ) async -> Bool {
        guard let session = activeSessions[surfaceId] else { return false }
        let envelope: [String: Any] = [
            "v": 1,
            "type": "event",
            "op": op,
            "eventId": randomHex(prefix: "ev", byteCount: 8),
            "sentAt": sentAt ?? timestampNow(),
            "payload": payload,
        ]
        guard let json = encodeJSON(envelope) else { return false }
        do {
            try await session.sender.send(text: json, priority: .event)
            return true
        } catch {
            surfaceById[surfaceId]?.lastError = "Event send failed: \(error.localizedDescription)"
            return false
        }
    }

    private func sendLifecycleEvent(surfaceId: String, op: String, payload: [String: Any]) {
        sendEvent(surfaceId: surfaceId, op: op, payload: payload)
    }

    private func broadcastLifecycleEvent(op: String, payload: [String: Any]) {
        for surfaceId in activeSessions.keys {
            sendEvent(surfaceId: surfaceId, op: op, payload: payload)
        }
    }

    private func sendSnapshotHint(surfaceId: String, reason: String) {
        guard eventIsEnabled(surfaceId: surfaceId, eventName: "event.snapshot_hint") else { return }
        sendEvent(surfaceId: surfaceId, op: "event.snapshot_hint", payload: ["reason": reason])
    }

    private func enqueuePostReconnectEvents(surfaceId: String) {
        Task { @MainActor in
            if self.eventIsEnabled(surfaceId: surfaceId, eventName: "event.snapshot_hint") {
                _ = await self.sendEventAsync(
                    surfaceId: surfaceId,
                    op: "event.snapshot_hint",
                    payload: ["reason": "after_reconnect"]
                )
            }
            _ = await self.sendEventAsync(
                surfaceId: surfaceId,
                op: "event.surface_resumed",
                payload: ["surfaceId": surfaceId]
            )
        }
    }

    private func eventIsEnabled(surfaceId: String, eventName: String) -> Bool {
        activeSessions[surfaceId]?.eventProfile.activeEvents.contains(eventName) == true
    }

    private func restorePaneDrawing(surfaceId: String, pane: SurfAcePaneModel) {
        guard let bridge = pane.bridge else { return }
        let restored = bridge.restoreDrawing(from: pane.currentEntry.drawingData, strokes: pane.activeStrokes)
        let hasPersistedDrawing = !pane.currentEntry.drawingData.isEmpty
        pane.drawingRestoreWarningVisible = hasPersistedDrawing && !restored
        if pane.drawingRestoreWarningVisible {
            pane.toast = "Annotation restore failed"
        }
    }

    private func scheduleDrawingFlush(surfaceId: String, paneId: Int) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        pane.pendingFlushTask?.cancel()

        guard !pane.pendingFlushStrokes.isEmpty,
              let session = activeSessions[surfaceId],
              let lastDirtyAt = pane.lastPendingStrokeAt else { return }

        let lastSuccessfulSendAt = pane.lastSuccessfulFlushAt ?? session.pairedAt
        let config = session.drawingFlushConfig
        let idleDeadline = lastDirtyAt + Int64(config.idleWindowMs)
        let maxDeadline = Int64(lastSuccessfulSendAt.timeIntervalSince1970 * 1000) + Int64(config.maxIntervalMs)
        let fireAt = min(idleDeadline, maxDeadline)
        let delay = max(0, fireAt - timestampNow())

        pane.pendingFlushTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Int(delay)))
            guard !Task.isCancelled else { return }
            await MainActor.run {
                self?.flushDrawing(surfaceId: surfaceId, paneId: paneId)
            }
        }
    }

    private func reschedulePendingFlushes(surfaceId: String) {
        guard let surface = surfaceById[surfaceId] else { return }
        for pane in surface.panes where !pane.pendingFlushStrokes.isEmpty {
            scheduleDrawingFlush(surfaceId: surfaceId, paneId: pane.paneId)
        }
    }

    private func flushDrawing(surfaceId: String, paneId: Int) {
        guard let session = activeSessions[surfaceId],
              let pane = pane(surfaceId: surfaceId, paneId: paneId),
              let contentId = pane.currentEntry.contentId,
              !pane.pendingFlushStrokes.isEmpty else {
            return
        }

        let config = session.drawingFlushConfig
        let lastDirtyAt = pane.lastPendingStrokeAt ?? timestampNow()
        let reason: String
        if let lastSuccessfulFlushAt = pane.lastSuccessfulFlushAt {
            let elapsed = Int64(Date().timeIntervalSince(lastSuccessfulFlushAt) * 1000)
            reason = elapsed >= Int64(config.maxIntervalMs) ? "max_interval" : "idle_window"
        } else {
            reason = "idle_window"
        }

        let strokes = pane.pendingFlushStrokes
        let firstStrokeAt = pane.firstPendingStrokeAt ?? strokes.first?.points.first?.timestamp ?? timestampNow()
        let lastStrokeAt = strokes.last?.points.last?.timestamp ?? lastDirtyAt
        let pointsCount = strokes.reduce(0) { $0 + $1.points.count }

        pane.isDrawingFlushSending = true
        let payload: [String: Any] = [
            "paneId": paneId,
            "contentId": contentId,
            "revision": pane.currentEntry.revision,
            "flushId": randomHex(prefix: "fl", byteCount: 8),
            "flushReason": reason,
            "idleWindowMs": config.idleWindowMs,
            "maxIntervalMs": config.maxIntervalMs,
            "strokes": jsonObject(fromEncodable: strokes) ?? [],
            "strokeCount": strokes.count,
            "pointsCount": pointsCount,
            "firstStrokeAt": firstStrokeAt,
            "lastStrokeAt": lastStrokeAt,
        ]

        Task { @MainActor in
            let succeeded = await self.sendEventAsync(surfaceId: surfaceId, op: "event.drawing_flush", payload: payload)
            guard let pane = self.pane(surfaceId: surfaceId, paneId: paneId) else { return }
            pane.isDrawingFlushSending = false
            if succeeded {
                pane.pendingFlushStrokes.removeAll()
                pane.deliveredClosedFrameCount += 1
                pane.firstPendingStrokeAt = nil
                pane.lastPendingStrokeAt = nil
                pane.lastSuccessfulFlushAt = Date()
                self.drainPendingAnnotationCommit(surfaceId: surfaceId, paneId: paneId)
            } else {
                self.scheduleDrawingFlush(surfaceId: surfaceId, paneId: paneId)
            }
        }
    }

    private func requestAnnotationCommit(surfaceId: String, paneId: Int) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId),
              pane.currentEntry.contentId != nil else {
            return
        }
        pane.pendingAnnotationCommit = true
        if pane.isDrawingFlushSending {
            return
        }
        if !pane.pendingFlushStrokes.isEmpty {
            flushDrawing(surfaceId: surfaceId, paneId: paneId)
            return
        }
        drainPendingAnnotationCommit(surfaceId: surfaceId, paneId: paneId)
    }

    private func drainPendingAnnotationCommit(surfaceId: String, paneId: Int) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId),
              pane.pendingAnnotationCommit else {
            return
        }
        guard eventIsEnabled(surfaceId: surfaceId, eventName: "event.annotation_committed"),
              let contentId = pane.currentEntry.contentId else {
            pane.pendingAnnotationCommit = false
            return
        }
        guard !pane.isDrawingFlushSending, pane.pendingFlushStrokes.isEmpty else {
            return
        }

        pane.pendingAnnotationCommit = false
        sendEvent(
            surfaceId: surfaceId,
            op: "event.annotation_committed",
            payload: [
                "paneId": paneId,
                "contentId": contentId,
                "revision": pane.currentEntry.revision,
                "committedAt": timestampNow(),
            ]
        )
    }

    private func pane(surfaceId: String, paneId: Int) -> SurfAcePaneModel? {
        surfaceById[surfaceId]?.panesById[paneId]
    }

    private func applyContentSet(frame: SurfAceFrame, to pane: SurfAcePaneModel, historyOwnerToken: String) -> [String: Any]? {
        let nextEntry = SurfAcePaneEntry.from(frame: frame, historyOwnerToken: historyOwnerToken)
        let shouldReplaceInPlace = pane.currentEntry.contentId != nil
            && pane.currentEntry.historyOwnerToken == historyOwnerToken

        if shouldReplaceInPlace {
            pane.currentEntry = nextEntry
            return nil
        }

        var historyInfo: [String: Any]?
        if pane.currentEntry.contentId != nil {
            let displacedEntry = pane.currentEntry
            pane.backStack.append(displacedEntry)
            if pane.backStack.count > 20 {
                pane.backStack.removeFirst(pane.backStack.count - 20)
            }

            if let displacedContentId = displacedEntry.contentId,
               let displacedHistoryOwnerToken = displacedEntry.historyOwnerToken,
               displacedHistoryOwnerToken != historyOwnerToken {
                historyInfo = [
                    "historyAction": "displaced",
                    "displaced": [
                        "contentId": displacedContentId,
                        "historyOwnerToken": displacedHistoryOwnerToken,
                    ],
                ]
            }
        }
        pane.forwardStack.removeAll()
        pane.currentEntry = nextEntry
        return historyInfo
    }

    private func applyProviderBootstrapTopology(
        surface: SurfAceSurfaceModel,
        windowLabel: String,
        initialPaneId: Int,
        initialPaneLabel: Int
    ) {
        if surface.windowLabel != windowLabel {
            surface.windowLabel = windowLabel
            surface.name = "\(screenName) \(windowLabel.uppercased())"
        }

        guard initialPaneId > 0, initialPaneLabel > 0, !surface.providerTopologyInitialized else {
            return
        }

        if case .leaf(let currentPaneId) = surface.paneLayout,
           let bootstrapPane = surface.panesById[currentPaneId],
           currentPaneId != initialPaneId {
            surface.panesById.removeValue(forKey: currentPaneId)
            bootstrapPane.paneId = initialPaneId
            surface.panesById[initialPaneId] = bootstrapPane
            surface.paneLayout = surface.paneLayout.replacingPaneID(from: currentPaneId, to: initialPaneId)
        }
        surface.panesById[initialPaneId]?.paneLabel = initialPaneLabel
        surface.providerTopologyInitialized = true
    }

    private func viewportPayload(for surface: SurfAceSurfaceModel) -> [String: Any] {
        [
            "width": max(Int(surface.viewportSize.width.rounded()), 1),
            "height": max(Int(surface.viewportSize.height.rounded()), 1),
            "scale": Double(max(surface.viewportScale, 1)),
        ]
    }

    private func paneViewportPayload(surfaceId: String, paneId: Int) -> [String: Any] {
        guard let surface = surfaceById[surfaceId] else {
            return ["width": 1, "height": 1, "scale": 1]
        }
        let rect = paneRect(in: CGRect(origin: .zero, size: surface.viewportSize), layout: surface.paneLayout, targetPaneId: paneId) ?? CGRect(x: 0, y: 0, width: 1, height: 1)
        return [
            "width": max(Int(rect.width.rounded()), 1),
            "height": max(Int(rect.height.rounded()), 1),
            "scale": Double(max(surface.viewportScale, 1)),
        ]
    }

    private func paneRect(in rect: CGRect, layout: SurfAcePaneLayoutNode, targetPaneId: Int) -> CGRect? {
        switch layout {
        case .empty:
            return nil
        case .leaf(let paneId):
            return paneId == targetPaneId ? rect : nil
        case .split(let direction, let children):
            guard !children.isEmpty else { return nil }
            switch direction {
            case .horizontal:
                let childHeight = rect.height / CGFloat(children.count)
                for (index, child) in children.enumerated() {
                    let childRect = CGRect(
                        x: rect.minX,
                        y: rect.minY + CGFloat(index) * childHeight,
                        width: rect.width,
                        height: childHeight
                    )
                    if let match = paneRect(in: childRect, layout: child, targetPaneId: targetPaneId) {
                        return match
                    }
                }
            case .vertical:
                let childWidth = rect.width / CGFloat(children.count)
                for (index, child) in children.enumerated() {
                    let childRect = CGRect(
                        x: rect.minX + CGFloat(index) * childWidth,
                        y: rect.minY,
                        width: childWidth,
                        height: rect.height
                    )
                    if let match = paneRect(in: childRect, layout: child, targetPaneId: targetPaneId) {
                        return match
                    }
                }
            }
            return nil
        }
    }

    private func publishBonjour() {
        surfAceServerRuntimeLog("publishing bonjour name=\(screenName) port=\(serverPort)")
        bonjourPublisher.publish(name: screenName, port: serverPort, txtRecord: bonjourTXTRecord())
    }

    private func refreshBonjourTXT() {
        guard isStarted else { return }
        surfAceServerRuntimeLog("refresh bonjour TXT busy=\(ownershipLocksBySurfaceId.isEmpty ? 0 : 1) surfaceCount=\(surfaces.count)")
        bonjourPublisher.updateTXTRecord(bonjourTXTRecord())
    }

    private func bonjourTXTRecord() -> [String: String] {
        let firstSurface = surfaces.first
        let viewport = firstSurface.map(viewportPayload(for:)) ?? ["width": 1, "height": 1, "scale": 1]
        return [
            "name": screenName,
            "v": "1",
            "w": "\(viewport["width"] ?? 1)",
            "h": "\(viewport["height"] ?? 1)",
            "s": "\(viewport["scale"] ?? 1)",
            "cap": "\(contentBitmask(for: supportedContentTypes))",
            "busy": ownershipLocksBySurfaceId.isEmpty ? "0" : "1",
            "pk": fingerprint,
            "ws": webSocketPath,
            "tls": "0",
        ]
    }

    private func defaultViewport(surface: SurfAceSurfaceModel?) -> SurfAceViewport {
        SurfAceViewport(
            scrollOffset: SurfAcePoint(x: 0, y: 0),
            visibleRect: SurfAceRect(
                x: 0,
                y: 0,
                width: Double(max(surface?.viewportSize.width ?? 1, 1)),
                height: Double(max(surface?.viewportSize.height ?? 1, 1))
            ),
            contentSize: SurfAceSize(
                width: Double(max(surface?.viewportSize.width ?? 1, 1)),
                height: Double(max(surface?.viewportSize.height ?? 1, 1))
            ),
            zoomLevel: 1
        )
    }

    private func normalizeURL(_ url: String) -> String? {
        let trimmed = url.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard var components = URLComponents(string: trimmed) else { return trimmed }
        components.fragment = nil
        return components.string ?? trimmed
    }

    private func payloadByteCount(_ payload: [String: Any]) -> Int {
        (try? JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys]).count) ?? 0
    }

    private func makeErrorResponse(
        op: String,
        id: String,
        code: String,
        message: String,
        details: [String: Any]? = nil
    ) -> [String: Any] {
        var error: [String: Any] = [
            "code": code,
            "message": message,
        ]
        if let details {
            error["details"] = details
        }

        return [
            "v": 1,
            "type": "response",
            "op": op,
            "id": id,
            "ok": false,
            "sentAt": timestampNow(),
            "error": error,
        ]
    }

    private func decodeJSONObject(from text: String) -> [String: Any]? {
        guard let data = text.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object
    }

    private func jsonValue<T>(_ value: T?) -> Any {
        value ?? NSNull()
    }

    private func encodeJSON(_ object: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(object),
              let data = try? JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]),
              let text = String(data: data, encoding: .utf8) else {
            return nil
        }
        return text
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
            return UUID().uuidString
        }
        return SHA256.hash(data: data).compactMap { String(format: "%02x", $0) }.joined()
    }

    private func jsonResponse(statusCode: Int, body: [String: Any]) -> HTTPServerResponse {
        let data = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data()
        return HTTPServerResponse(
            statusCode: statusCode,
            headers: ["Content-Type": "application/json"],
            body: data
        )
    }

    private func loadIdentityMapping() {
        guard let data = UserDefaults.standard.data(forKey: mappingStoreKey),
              let mapping = try? JSONDecoder().decode(SurfAceIdentityMapping.self, from: data) else {
            identityMapping = SurfAceIdentityMapping()
            return
        }
        identityMapping = mapping
    }

    private func persistIdentityMapping() {
        guard let data = try? JSONEncoder().encode(identityMapping) else { return }
        UserDefaults.standard.set(data, forKey: mappingStoreKey)
    }

    private func normalizedWindowLabel(from value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func normalizedHistoryOwnerToken(from value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func contentBitmask(for contentTypes: [SurfAceContentType]) -> Int {
        let bits: [SurfAceContentType: Int] = [
            .html: 1 << 0,
            .image: 1 << 1,
            .pdf: 1 << 2,
            .terminal: 1 << 3,
            .markdown: 1 << 4,
            .video: 1 << 5,
            .canvas: 1 << 6,
        ]
        return contentTypes.reduce(0) { $0 | (bits[$1] ?? 0) }
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
    private let encodeImpl: (Encoder) throws -> Void

    init(_ value: Encodable) {
        self.encodeImpl = { encoder in
            try value.encode(to: encoder)
        }
    }

    func encode(to encoder: Encoder) throws {
        try encodeImpl(encoder)
    }
}
