import CryptoKit
import Foundation
import Observation
import Network
import UIKit

private func surfAceDiagnosticValue(_ value: CustomStringConvertible) -> String {
    let text = String(describing: value)
    return text.range(of: #"^[A-Za-z0-9_./:@%-]+$"#, options: .regularExpression) != nil
        ? text
        : "\"\(text.replacingOccurrences(of: "\"", with: "\\\""))\""
}

private func surfAceDiagnosticFields(_ fields: [(String, CustomStringConvertible?)]) -> String {
    fields.compactMap { key, value in
        guard let value else { return nil }
        let text = String(describing: value)
        guard !text.isEmpty else { return nil }
        return "\(key)=\(surfAceDiagnosticValue(value))"
    }.joined(separator: " ")
}

private func surfAceServerRuntimeLog(_ message: String) {
    print("[SurfAce-Server] \(message)")
}

private func surfAceGatewayLog(_ message: String) {
    print("[SurfAce-Gateway] \(message)")
}

private func surfAceLifecycleLog(_ message: String) {
    print("[SurfAce-Lifecycle] \(message)")
}

func surfAceValidatedProviderWindowLabel(from value: Any?) -> String? {
    guard let label = value as? String else { return nil }
    guard label.range(of: #"^[a-z]+$"#, options: .regularExpression) != nil else { return nil }
    return label
}

func surfAceValidatedPositiveProviderIdentifier(from value: Any?) -> Int? {
    guard let identifier = value as? Int, identifier > 0 else { return nil }
    return identifier
}

struct SurfAceProviderBootstrapIdentity {
    let windowLabel: String
    let initialPaneId: Int
    let initialPaneLabel: Int
}

struct SurfAceAuthorityPaneIdentity {
    let paneId: Int
    let paneLabel: Int
    let paneLineageId: String?
}

func surfAceValidatedProviderBootstrapIdentity(from payload: [String: Any]) -> SurfAceProviderBootstrapIdentity? {
    guard let windowLabel = surfAceValidatedProviderWindowLabel(from: payload["windowLabel"]),
          let initialPaneId = surfAceValidatedPositiveProviderIdentifier(from: payload["initialPaneId"]),
          let initialPaneLabel = surfAceValidatedPositiveProviderIdentifier(from: payload["initialPaneLabel"]) else {
        return nil
    }
    return SurfAceProviderBootstrapIdentity(
        windowLabel: windowLabel,
        initialPaneId: initialPaneId,
        initialPaneLabel: initialPaneLabel
    )
}

func surfAceAuthorityStateRejectionReason(
    payload: [String: Any],
    surfaceId: String,
    providerId: String,
    sessionId: String,
    ownershipEpoch: Int,
    lockProviderId: String,
    lockSessionId: String,
    windowLabel: String,
    panes: [SurfAceAuthorityPaneIdentity]
) -> String? {
    if payload["surfaceId"] as? String != surfaceId {
        return "surface_id_mismatch"
    }
    if payload["providerId"] as? String != providerId ||
        payload["sessionId"] as? String != sessionId ||
        payload["ownershipEpoch"] as? Int != ownershipEpoch ||
        lockProviderId != providerId ||
        lockSessionId != sessionId {
        return "session_identity_mismatch"
    }
    if surfAceValidatedProviderWindowLabel(from: payload["windowLabel"]) == nil {
        return "window_label_mismatch"
    }
    guard let payloadPanes = payload["panes"] as? [[String: Any]],
          payloadPanes.count == panes.count else {
        return "pane_identity_mismatch"
    }
    let panesById = Dictionary(uniqueKeysWithValues: panes.map { ($0.paneId, $0) })
    var seenPaneIds = Set<Int>()
    for candidate in payloadPanes {
        guard let paneId = candidate["paneId"] as? Int,
              seenPaneIds.insert(paneId).inserted,
              let pane = panesById[paneId],
              candidate["paneLabel"] as? Int == pane.paneLabel,
              candidate["paneLineageId"] as? String == pane.paneLineageId else {
            return "pane_identity_mismatch"
        }
    }
    if payload["actionable"] as? Bool != true {
        return payload["reason"] as? String ?? "provider_not_actionable"
    }
    return nil
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
    let supersededSession: SurfAceSessionState?
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
    let ownershipEpoch: Int
    let pairedAt: Date
    var pairConfirmed: Bool
    var authorityConfirmed: Bool
}

private struct SurfAceOwnershipLockState {
    let sessionId: String
    let providerId: String
    let ownershipEpoch: Int
}

final class SurfAceSceneDisconnectObserver {
    private let notificationCenter: NotificationCenter
    private let onDisconnect: @MainActor () -> Void
    private var observer: NSObjectProtocol?

    init(
        notificationCenter: NotificationCenter = .default,
        onDisconnect: @escaping @MainActor () -> Void
    ) {
        self.notificationCenter = notificationCenter
        self.onDisconnect = onDisconnect
    }

    func observe(sceneObject: AnyObject) {
        invalidate()
        let onDisconnect = self.onDisconnect
        observer = notificationCenter.addObserver(
            forName: UIScene.didDisconnectNotification,
            object: sceneObject,
            queue: nil
        ) { _ in
            Task { @MainActor in
                onDisconnect()
            }
        }
    }

    func invalidate() {
        if let observer {
            notificationCenter.removeObserver(observer)
            self.observer = nil
        }
    }

    deinit {
        invalidate()
    }
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
    @ObservationIgnored private let surfaceTopologyStoreKey = "SurfAce.SurfaceTopologyMapping"
    @ObservationIgnored private let userDefaults: UserDefaults
    @ObservationIgnored private var identity: SurfAceIdentity?
    @ObservationIgnored private var isStarted = false
    @ObservationIgnored private var isStarting = false
    @ObservationIgnored private var surfaceById: [String: SurfAceSurfaceModel] = [:]
    @ObservationIgnored private var surfaceIdBySceneKey: [String: String] = [:]
    @ObservationIgnored private var sceneDisconnectObserversBySceneKey: [String: SurfAceSceneDisconnectObserver] = [:]
    @ObservationIgnored private var activeSessions: [String: SurfAceSessionState] = [:]
    @ObservationIgnored private var lastHeartbeatAtBySurfaceId: [String: Date] = [:]
    @ObservationIgnored private var ownershipLocksBySurfaceId: [String: SurfAceOwnershipLockState] = [:]
    @ObservationIgnored private var surfaceNeedsResumedEvent: Set<String> = []
    @ObservationIgnored private var terminatedConnectionUUIDs: Set<String> = []
    @ObservationIgnored private var identityMapping = SurfAceIdentityMapping()
    @ObservationIgnored private var persistedSurfaceTopologies: [String: SurfAcePersistedSurfaceTopology] = [:]
    @ObservationIgnored private var heartbeatWatchdogTask: Task<Void, Never>?

    private let maxMessageBytes = 12 * 1024 * 1024
    private let maxFrameBytes = 10 * 1024 * 1024
    private let maxVisibleTextBytes = 4_096
    private let maxStrokePointsPerFlush = 8_192
    private let maxDrawingFlushBytes = 2 * 1024 * 1024
    private let resumeGraceMilliseconds = 20_000
    private let heartbeatTimeoutMilliseconds = 25_000
    private let heartbeatWatchdogCheckMilliseconds = 5_000
    private let webSocketPath = "/ws"
    private let healthPath = "/health"
    private let supportedContentTypes: [SurfAceContentType] = [.html, .image, .pdf, .terminal, .markdown]
    private let targetCapabilities = [
        "target.browser_url.v1",
    ]
    private let eventTypes = [
        "event.drawing_flush",
        "event.annotation_committed",
        "event.history_navigated",
        "event.tap",
        "event.scroll",
        "event.selection",
        "event.page",
        "event.navigation",
        "event.surface_appeared",
        "event.surface_removed",
        "event.surface_resumed",
        "event.topology_changed",
        "event.snapshot_hint",
        "event.pane_created",
        "event.pane_removed",
        "event.pane_renamed",
    ]

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
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
        loadPersistedSurfaceTopologies()
        surfAceLifecycleLog(
            "event=runtime_init \(surfAceDiagnosticFields([("fingerprint", fingerprint), ("screen_name", screenName)]))"
        )
        bonjourPublisher.onPublishFailure = { [weak self] details in
            Task { @MainActor in
                self?.endpointError = "Bonjour publish failed (\(details)); WS server remains available"
            }
        }
    }

    func start() async {
        guard !isStarted, !isStarting else { return }
        isStarting = true
        defer { isStarting = false }
        observeLifecycle()
        surfAceLifecycleLog(
            "event=app_launch \(surfAceDiagnosticFields([("fingerprint", fingerprint), ("screen_name", screenName)]))"
        )
        surfAceServerRuntimeLog(
            "event=server_start_request \(surfAceDiagnosticFields([("fixed_port", fixedServerPort), ("health_path", healthPath), ("ws_path", webSocketPath)]))"
        )

        do {
            let port = try await server.start(
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
            surfAceServerRuntimeLog(
                "event=server_start_ok \(surfAceDiagnosticFields([("fingerprint", fingerprint), ("port", serverPort), ("requested_port", fixedServerPort), ("screen_name", screenName)]))"
            )
            startHeartbeatWatchdog()
            publishBonjour()
        } catch {
            let details = startupFailureMessage(for: error)
            surfAceServerRuntimeLog(
                "event=server_start_failed \(surfAceDiagnosticFields([("error", details), ("fixed_port", fixedServerPort)]))"
            )
            endpointError = details
        }
    }

    func stop() async {
        surfAceLifecycleLog(
            "event=app_stop \(surfAceDiagnosticFields([("active_sessions", activeSessions.count), ("surface_count", surfaces.count)]))"
        )
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
        surfAceServerRuntimeLog("event=server_stop_complete")
    }

    func registerSurface(sceneKey: String, scene: UIScene? = nil) -> SurfAceSurfaceModel {
        if let existingSurfaceId = surfaceIdBySceneKey[sceneKey],
           let existing = surfaceById[existingSurfaceId] {
            if let scene {
                ensureSceneDisconnectObservation(sceneKey: sceneKey, scene: scene)
            }
            return existing
        }
        if let scene {
            ensureSceneDisconnectObservation(sceneKey: sceneKey, scene: scene)
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
        if let persistedTopology = persistedSurfaceTopologies[surfaceId] {
            persistedTopology.apply(to: surface)
        }
        ensureActiveKeyboardPane(surface: surface)
        surfaceById[surfaceId] = surface
        surfaceIdBySceneKey[sceneKey] = surfaceId
        surfaces.append(surface)
        persistSurfaceTopology(surfaceId: surfaceId)
        surfAceLifecycleLog(
            "event=scene_connect \(surfAceDiagnosticFields([("restored_topology", persistedSurfaceTopologies[surfaceId] != nil), ("scene_key", sceneKey), ("surface_id", surfaceId)]))"
        )
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
        sceneDisconnectObserversBySceneKey.removeValue(forKey: sceneKey)?.invalidate()
        guard let surfaceId = surfaceIdBySceneKey.removeValue(forKey: sceneKey),
              let surface = surfaceById.removeValue(forKey: surfaceId) else {
            return
        }

        persistedSurfaceTopologies[surfaceId] = SurfAcePersistedSurfaceTopology(surface: surface)
        persistSurfaceTopologies()
        surfAceLifecycleLog(
            "event=scene_disconnect \(surfAceDiagnosticFields([("pane_count", surface.panes.count), ("scene_key", sceneKey), ("surface_id", surfaceId)]))"
        )
        for pane in surface.panes {
            pane.pendingFlushTask?.cancel()
            pane.pendingFlushTask = nil
        }
        surfaces.removeAll { $0.surfaceId == surfaceId }
        identityMapping.surfacesBySceneKey.removeValue(forKey: sceneKey)
        persistIdentityMapping()
        persistedSurfaceTopologies.removeValue(forKey: surfaceId)
        persistSurfaceTopologies()

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

    private func ensureSceneDisconnectObservation(sceneKey: String, scene: UIScene) {
        if let observer = sceneDisconnectObserversBySceneKey[sceneKey] {
            observer.observe(sceneObject: scene)
            return
        }

        let observer = SurfAceSceneDisconnectObserver { [weak self] in
            self?.unregisterSurface(sceneKey: sceneKey)
        }
        observer.observe(sceneObject: scene)
        sceneDisconnectObserversBySceneKey[sceneKey] = observer
    }

    func updateViewport(surfaceId: String, size: CGSize, scale: CGFloat) {
        guard let surface = surfaceById[surfaceId], size.width > 0, size.height > 0 else { return }
        let nextScale = max(scale, 1)
        if surface.viewportSize != size || surface.viewportScale != nextScale {
            surface.surfaceEpoch += 1
        }
        surface.viewportSize = size
        surface.viewportScale = nextScale
        refreshBonjourTXT()
    }

    func updatePaneGeometrySnapshot(
        surfaceId: String,
        paneId: Int,
        paneFrame: CGRect,
        contentViewport: CGRect,
        splitSpacing: CGFloat
    ) {
        guard let surface = surfaceById[surfaceId],
              let pane = surface.panesById[paneId],
              paneFrame.width > 0,
              paneFrame.height > 0,
              contentViewport.width > 0,
              contentViewport.height > 0 else {
            return
        }

        let candidate = SurfAcePaneGeometrySnapshot(
            paneId: paneId,
            paneInstanceId: pane.paneInstanceId,
            topologyEpoch: surface.topologyEpoch,
            surfaceEpoch: surface.surfaceEpoch,
            geometryRevision: pane.geometrySnapshot?.geometryRevision ?? 0,
            coordinateSpace: SurfAcePaneGeometrySnapshot.coordinateSpace,
            surfaceBounds: CGRect(origin: .zero, size: surface.viewportSize),
            paneFrame: paneFrame,
            contentViewport: contentViewport,
            splitSpacing: splitSpacing,
            scale: surface.viewportScale
        )

        guard pane.geometrySnapshot != candidate else { return }
        surface.geometryRevision += 1
        pane.geometrySnapshot = candidate.withGeometryRevision(surface.geometryRevision)
    }

    func attachPaneBridge(surfaceId: String, paneId: Int, bridge: any SurfAcePaneBridging) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        pane.bridge = bridge
        bridge.render(entry: renderableEntry(pane.currentEntry), restoreViewport: nil)
        noteRenderDiagnostics(
            surfaceId: surfaceId,
            pane: pane,
            bridgeAttached: true,
            status: pane.currentEntry.contentId == nil ? "standby_rendered" : "render_requested",
            message: nil
        )
        restorePaneDrawing(surfaceId: surfaceId, pane: pane)
        bridge.setInteraction(annotationMode: pane.annotationMode, fingerDrawEnabled: pane.fingerDrawEnabled)
        if pane.currentEntry.contentType != .html,
           let reason = pane.pendingSnapshotHintReason {
            pane.pendingSnapshotHintReason = nil
            sendSnapshotHint(surfaceId: surfaceId, reason: reason)
        }
    }

    func detachPaneBridge(surfaceId: String, paneId: Int, bridge: (any SurfAcePaneBridging)? = nil) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        if let bridge, pane.bridge !== bridge {
            return
        }
        pane.bridge = nil
    }

    func setAnnotationMode(
        surfaceId: String,
        paneId: Int,
        enabled: Bool,
        fingerDrawEnabled: Bool,
        source: String? = nil
    ) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        activateKeyboardPane(surfaceId: surfaceId, paneId: paneId)
        let wasEnabled = pane.annotationMode
        pane.annotationMode = enabled
        pane.fingerDrawEnabled = enabled && fingerDrawEnabled
        pane.bridge?.setInteraction(annotationMode: pane.annotationMode, fingerDrawEnabled: pane.fingerDrawEnabled)
        let transitionSource = source ?? (enabled ? (fingerDrawEnabled ? "finger_button" : "annotation_button") : "done_button")
        surfAceLifecycleLog(
            "event=annotation_mode_changed \(surfAceDiagnosticFields([("surface_id", surfaceId), ("pane_id", paneId), ("enabled", pane.annotationMode), ("finger_draw_enabled", pane.fingerDrawEnabled), ("source", transitionSource)]))"
        )
        if wasEnabled && !enabled {
            requestAnnotationCommit(surfaceId: surfaceId, paneId: paneId)
        }
    }

    func handlePencilContact(surfaceId: String, paneId: Int) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        guard !pane.annotationMode else {
            activateKeyboardPane(surfaceId: surfaceId, paneId: paneId)
            return
        }
        setAnnotationMode(
            surfaceId: surfaceId,
            paneId: paneId,
            enabled: true,
            fingerDrawEnabled: false,
            source: "pencil_contact"
        )
    }

    func navigateHistory(surfaceId: String, paneId: Int, direction: HistoryDirection) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        activateKeyboardPane(surfaceId: surfaceId, paneId: paneId)
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

        pane.bridge?.render(entry: renderableEntry(pane.currentEntry), restoreViewport: nil)
        restorePaneDrawing(surfaceId: surfaceId, pane: pane)
        pane.lastNavigationURL = pane.currentEntry.url
        if eventIsEnabled(surfaceId: surfaceId, eventName: "event.history_navigated") {
            sendEvent(
                surfaceId: surfaceId,
                op: "event.history_navigated",
                payload: [
                    "paneId": paneId,
                    "contentId": jsonValue(pane.currentEntry.contentId),
                    "revision": pane.currentEntry.revision,
                    "direction": direction == .back ? "back" : "forward",
                ]
            )
        }
    }

    func reloadPane(surfaceId: String, paneId: Int) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        activateKeyboardPane(surfaceId: surfaceId, paneId: paneId)
        guard !pane.annotationMode else {
            pane.toast = "Finish annotation (Done) to navigate"
            return
        }
        if case .browserURL = pane.currentEntry.payload {
            pane.bridge?.reloadBrowserURL()
        }
    }

    func activateKeyboardPane(surfaceId: String, paneId: Int) {
        guard let surface = surfaceById[surfaceId],
              surface.panesById[paneId] != nil else { return }
        surface.activeKeyboardPaneId = paneId
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
        if let reason = pane.pendingSnapshotHintReason {
            pane.pendingSnapshotHintReason = nil
            sendSnapshotHint(surfaceId: surfaceId, reason: reason)
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
        guard !pane.annotationMode else {
            pane.toast = "Finish annotation (Done) to navigate"
            return
        }

        let previousEntry = pane.currentEntry
        if !isVisibleEmptyEntry(previousEntry) {
            pane.backStack.append(previousEntry)
            trimVisibleHistory(pane)
        }
        pane.forwardStack.removeAll()
        pane.currentEntry = .browserURL(
            targetId: contentId,
            targetEpoch: previousEntry.revision,
            url: normalized,
            title: previousEntry.title
        )
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

        if !pane.annotationMode {
            setAnnotationMode(
                surfaceId: surfaceId,
                paneId: paneId,
                enabled: true,
                fingerDrawEnabled: false,
                source: "pencil_stroke"
            )
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
        surfAceLifecycleLog(
            "event=app_background \(surfAceDiagnosticFields([("active_sessions", activeSessions.count), ("surface_count", surfaces.count)]))"
        )
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
        surfAceLifecycleLog(
            "event=app_foreground \(surfAceDiagnosticFields([("pending_resumed_events", surfaceNeedsResumedEvent.count), ("surface_count", surfaces.count)]))"
        )
        publishBonjour()
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
                            "authority.state",
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
        surfAceGatewayLog(
            "event=socket_open \(surfAceDiagnosticFields([("connection_uuid", connectionUUID)]))"
        )
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
                    surfAceGatewayLog(
                        "event=socket_close_frame \(surfAceDiagnosticFields([("connection_uuid", connectionUUID)]))"
                    )
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
        case "topology.apply":
            return SurfAceProcessedRequestResult(
                responseObject: handleTopologyApply(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "target.apply":
            return SurfAceProcessedRequestResult(
                responseObject: await handleTargetApply(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "target.register":
            return SurfAceProcessedRequestResult(
                responseObject: [
                    "v": 1,
                    "type": "response",
                    "op": "target.register.rejected",
                    "id": id,
                    "ok": true,
                    "sentAt": timestampNow(),
                    "payload": [
                        "idempotencyKey": payload["idempotencyKey"] as? String ?? "",
                        "status": "rejected",
                        "errorCode": "registration_failed",
                        "message": "target.register is provider-bound and is not accepted by the surface runtime",
                    ],
                ],
                postSendPairCommit: nil
            )
        case "content.apply":
            return SurfAceProcessedRequestResult(
                responseObject: await handleContentApply(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
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
        case "authority.state":
            return SurfAceProcessedRequestResult(
                responseObject: handleAuthorityState(id: id, payload: payload, connectionUUID: connectionUUID),
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
        surfAceGatewayLog(
            "event=pair_request_received \(surfAceDiagnosticFields([("connection_uuid", connectionUUID), ("provider_id", payload["providerId"] as? String), ("resume_session_id", resumeSessionId), ("surface_id", payload["surfaceId"] as? String), ("takeover", takeover)]))"
        )
        guard let providerId = payload["providerId"] as? String,
              let connectionId = payload["connectionId"] as? String,
              let protocolVersion = payload["protocolVersion"] as? Int,
              let surfaceId = payload["surfaceId"] as? String,
              let surface = surfaceById[surfaceId] else {
            surfAceGatewayLog(
                "event=pair_request_invalid_payload \(surfAceDiagnosticFields([("connection_uuid", connectionUUID)]))"
            )
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
        guard let bootstrapIdentity = surfAceValidatedProviderBootstrapIdentity(from: payload) else {
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(
                    op: "pair.request",
                    id: id,
                    code: "invalid_payload",
                    message: "windowLabel, initialPaneId, and initialPaneLabel are required; windowLabel must be a lowercase alphabetic provider identity label"
                ),
                postSendPairCommit: nil
            )
        }
        let providerWindowLabel = bootstrapIdentity.windowLabel
        let providerInitialPaneId = bootstrapIdentity.initialPaneId
        let providerInitialPaneLabel = bootstrapIdentity.initialPaneLabel
        guard let rawProviderName = payload["providerName"] as? String else {
            surfAceGatewayLog(
                "event=pair_request_missing_provider_name \(surfAceDiagnosticFields([("connection_uuid", connectionUUID)]))"
            )
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
            surfAceGatewayLog(
                "event=pair_request_empty_provider_name \(surfAceDiagnosticFields([("connection_uuid", connectionUUID)]))"
            )
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
        let ownershipEpoch: Int
        var supersededSession: SurfAceSessionState? = nil

        if let ownershipLock {
            if takeover {
                surfAceGatewayLog(
                    "event=pair_request_explicit_takeover \(surfAceDiagnosticFields([("active_session", activeSession != nil), ("previous_provider_id", ownershipLock.providerId), ("previous_session_id", ownershipLock.sessionId), ("provider_id", providerId), ("same_provider", ownershipLock.providerId == providerId), ("surface_id", surfaceId)]))"
                )
                resumed = false
                sessionId = randomHex(prefix: "sa", byteCount: 12)
                ownershipEpoch = ownershipLock.ownershipEpoch + 1
                if let activeSession, activeSession.connectionUUID != connectionUUID {
                    supersededSession = activeSession
                }
            } else if ownershipLock.providerId == providerId {
                guard resumeSessionId == ownershipLock.sessionId else {
                    surfAceGatewayLog(
                        "event=pair_request_invalid_resume \(surfAceDiagnosticFields([("expected_session_id", ownershipLock.sessionId), ("provider_id", providerId), ("received_session_id", resumeSessionId ?? "nil"), ("surface_id", surfaceId)]))"
                    )
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
                ownershipEpoch = ownershipLock.ownershipEpoch
                surfAceGatewayLog(
                    "event=pair_request_resumed \(surfAceDiagnosticFields([("provider_id", providerId), ("session_id", sessionId), ("surface_id", surfaceId)]))"
                )
                if let activeSession, activeSession.connectionUUID != connectionUUID {
                    supersededSession = activeSession
                }
            } else {
                surfAceGatewayLog(
                    "event=pair_request_busy \(surfAceDiagnosticFields([("lock_provider_id", ownershipLock.providerId), ("requested_provider_id", providerId), ("surface_id", surfaceId)]))"
                )
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
            ownershipEpoch = 1
            surfAceGatewayLog(
                "event=pair_request_new_session \(surfAceDiagnosticFields([("provider_id", providerId), ("session_id", sessionId), ("surface_id", surfaceId)]))"
            )
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
            ownershipEpoch: ownershipEpoch,
            pairedAt: Date(),
            pairConfirmed: false,
            authorityConfirmed: false
        )

        surfAceGatewayLog(
            "event=pair_response_ready \(surfAceDiagnosticFields([("pane_count", surface.panes.count), ("resumed", resumed), ("session_id", sessionId), ("surface_id", surfaceId)]))"
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
                "ownershipEpoch": ownershipEpoch,
                "resumed": resumed,
                "surfaceId": surface.surfaceId,
                "surfaceName": surface.name,
                "viewport": viewportPayload(for: surface),
                "capabilities": [
                    "contentTypes": supportedContentTypes.map(\.rawValue),
                    "eventTypes": eventTypes,
                    "protocolFeatures": ["authority.state.v1"],
                    "targetCapabilities": targetCapabilities,
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
                            "paneLineageId": pane.paneLineageId,
                            "paneLabel": pane.paneLabel,
                            "currentContentId": jsonValue(pane.currentEntry.contentId),
                            "currentRevision": pane.currentEntry.revision,
                            "contentType": jsonValue(pane.currentEntry.contentType?.rawValue),
                            "currentTarget": jsonValue(targetStatePayload(pane.currentTarget)),
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
                supersededSession: supersededSession,
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
        surfAceGatewayLog(
            "event=pair_commit \(surfAceDiagnosticFields([("provider_id", plan.session.providerId), ("resumed", plan.resumed), ("session_id", plan.session.sessionId), ("surface_id", plan.surfaceId)]))"
        )
        if plan.resumed {
            applyProviderWindowLabel(surface: surface, windowLabel: plan.providerWindowLabel)
        } else {
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
            providerId: plan.session.providerId,
            ownershipEpoch: plan.session.ownershipEpoch
        )
        lastHeartbeatAtBySurfaceId[plan.surfaceId] = Date()
        refreshConnectionState(surfaceId: plan.surfaceId)
        reschedulePendingFlushes(surfaceId: plan.surfaceId)
        refreshBonjourTXT()
        if let supersededSession = plan.supersededSession,
           supersededSession.connectionUUID != plan.session.connectionUUID {
            Task {
                await supersededSession.socket.close(code: 1000, reason: "superseded")
            }
        }

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
                        "paneLineageId": pane.paneLineageId,
                        "paneLabel": pane.paneLabel,
                        "name": jsonValue(pane.name),
                        "activeContentId": jsonValue(pane.currentEntry.contentId),
                        "contentType": jsonValue(pane.currentEntry.contentType?.rawValue),
                        "currentTarget": jsonValue(targetStatePayload(pane.currentTarget)),
                        "viewport": paneViewportPayload(surfaceId: surfaceId, paneId: pane.paneId),
                        "geometry": paneGeometryPayload(surfaceId: surfaceId, paneId: pane.paneId),
                    ]
                },
            ],
        ]
    }

    private func handleTopologyApply(id: String, payload: [String: Any], connectionUUID: String) -> [String: Any] {
        guard let (surfaceId, surface) = pairedSurface(for: connectionUUID),
              let topologyRevision = payload["topologyRevision"] as? Int,
              let windowLabel = surfAceValidatedProviderWindowLabel(from: payload["windowLabel"]),
              let panesPayload = payload["panes"] as? [[String: Any]],
              let layoutPayload = payload["layout"] as? [String: Any] else {
            return makeErrorResponse(op: "topology.apply", id: id, code: "invalid_payload", message: "invalid topology.apply payload")
        }
        guard surface.windowLabel == windowLabel else {
            return makeErrorResponse(
                op: "topology.apply",
                id: id,
                code: "invalid_payload",
                message: "topology.apply windowLabel must match the paired surface identity"
            )
        }

        var panesById: [Int: SurfAcePaneModel] = [:]
        var visiblePaneLabels = Set<Int>()
        for panePayload in panesPayload {
            guard let paneId = panePayload["paneId"] as? Int,
                  let paneLabel = panePayload["paneLabel"] as? Int else {
                return makeErrorResponse(op: "topology.apply", id: id, code: "invalid_payload", message: "invalid topology.apply panes")
            }
            guard paneLabel > 0, !visiblePaneLabels.contains(paneLabel) else {
                return makeErrorResponse(op: "topology.apply", id: id, code: "invalid_payload", message: "duplicate or invalid paneLabel in surface payload")
            }
            visiblePaneLabels.insert(paneLabel)
            let pane = surface.panesById[paneId] ?? SurfAcePaneModel(paneId: paneId, paneLabel: paneLabel)
            pane.paneLabel = paneLabel
            pane.name = (panePayload["name"] as? String)?.isEmpty == true ? nil : panePayload["name"] as? String
            panesById[paneId] = pane
        }

        guard let layout = parseTopologyLayoutNode(layoutPayload, panesById: panesById) else {
            return makeErrorResponse(op: "topology.apply", id: id, code: "invalid_payload", message: "invalid topology.apply layout")
        }

        surface.windowLabel = windowLabel
        surface.name = "\(screenName) \(windowLabel.uppercased())"
        surface.panesById = panesById
        surface.paneLayout = layout
        surface.topologyEpoch += 1
        surface.providerTopologyInitialized = topologyRevision > 0
        ensureActiveKeyboardPane(surface: surface)
        persistSurfaceTopology(surfaceId: surfaceId)

        return [
            "v": 1,
            "type": "response",
            "op": "topology.apply",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "topologyRevision": topologyRevision,
                "panes": layout.paneIDs.compactMap { paneId -> [String: Any]? in
                    guard let pane = panesById[paneId] else { return nil }
                    return [
                        "paneId": pane.paneId,
                        "paneLineageId": pane.paneLineageId,
                        "paneLabel": pane.paneLabel,
                        "name": jsonValue(pane.name),
                    ]
                },
            ],
        ]
    }

    private func handleContentApply(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        guard let (surfaceId, _) = pairedSurface(for: connectionUUID) else {
            return makeErrorResponse(op: "content.apply", id: id, code: "not_paired", message: "pair.request required")
        }
        return await handleContentApply(id: id, payload: payload, surfaceId: surfaceId)
    }

    private func handleContentApply(id: String, payload: [String: Any], surfaceId: String) async -> [String: Any] {
        guard let paneId = payload["paneId"] as? Int,
              let pane = pane(surfaceId: surfaceId, paneId: paneId),
              let revision = payload["revision"] as? Int else {
            return makeErrorResponse(op: "content.apply", id: id, code: "invalid_payload", message: "paneId and revision are required")
        }

        if let clear = payload["clear"] as? Bool, clear {
            guard revision == pane.currentEntry.revision + 1 else {
                return staleRevisionResponse(op: "content.apply", id: id, expectedRevision: pane.currentEntry.revision + 1)
            }
            guard !pane.annotationMode else {
                pane.toast = "Finish annotation (Done) to navigate"
                return makeErrorResponse(op: "content.apply", id: id, code: "invalid_operation", message: "annotation mode is active")
            }
            if !isVisibleEmptyEntry(pane.currentEntry) {
                pane.backStack.append(pane.currentEntry)
                trimVisibleHistory(pane)
            }
            pane.forwardStack.removeAll()
            pane.currentTarget = nil
            pane.currentEntry = .empty(revision: revision)
            pane.pendingFlushStrokes.removeAll()
            pane.firstPendingStrokeAt = nil
            pane.lastPendingStrokeAt = nil
            pane.lastSelection = nil
            pane.lastNavigationURL = nil
            pane.lastPage = nil
            pane.pendingSnapshotHintReason = nil
            pane.bridge?.render(entry: nil, restoreViewport: nil)
            restorePaneDrawing(surfaceId: surfaceId, pane: pane)
            var response = mutationAck(id: id, op: "content.apply", paneId: paneId, entry: pane.currentEntry)
            if var payloadObject = response["payload"] as? [String: Any],
               let topologyRevision = payload["topologyRevision"] as? Int {
                payloadObject["topologyRevision"] = topologyRevision
                response["payload"] = payloadObject
            }
            return response
        }

        guard let contentId = payload["contentId"] as? String else {
            return makeErrorResponse(op: "content.apply", id: id, code: "invalid_payload", message: "contentId is required")
        }
        guard revision == pane.currentEntry.revision + 1 else {
            return staleRevisionResponse(op: "content.apply", id: id, expectedRevision: pane.currentEntry.revision + 1)
        }
        guard !pane.annotationMode else {
            pane.toast = "Finish annotation (Done) to navigate"
            return makeErrorResponse(op: "content.apply", id: id, code: "invalid_operation", message: "annotation mode is active")
        }
        guard payloadByteCount(payload) <= maxFrameBytes else {
            return makeErrorResponse(op: "content.apply", id: id, code: "content_too_large", message: "content exceeds maxFrameBytes")
        }

        let frame: SurfAceFrame
        do {
            frame = try SurfAceFrame.from(contentId: contentId, revision: revision, jsonObject: payload)
        } catch SurfAceFrameParseError.unsupportedType {
            return makeErrorResponse(op: "content.apply", id: id, code: "unsupported_content_type", message: "unsupported contentType")
        } catch SurfAceFrameParseError.invalidContentID {
            return makeErrorResponse(op: "content.apply", id: id, code: "invalid_payload", message: "contentId must match ct_<8hex>")
        } catch SurfAceFrameParseError.missingField(let field) {
            return makeErrorResponse(op: "content.apply", id: id, code: "invalid_payload", message: "missing \(field)")
        } catch {
            return makeErrorResponse(op: "content.apply", id: id, code: "invalid_payload", message: "invalid content.apply payload")
        }

        if frame.contentType == .canvas {
            return makeErrorResponse(op: "content.apply", id: id, code: "unsupported_content_type", message: "unsupported contentType")
        }

        guard let historyOwnerToken = normalizedHistoryOwnerToken(from: payload["historyOwnerToken"]) else {
            return makeErrorResponse(op: "content.apply", id: id, code: "invalid_payload", message: "historyOwnerToken is required")
        }
        let shouldRestoreViewport = shouldPreserveHTMLViewportAcrossContentSet(
            currentEntry: pane.currentEntry,
            incomingFrame: frame,
            historyOwnerToken: historyOwnerToken
        )
        let restoreViewport: SurfAceViewport?
        if shouldRestoreViewport,
           let snapshot = await pane.bridge?.fetchSnapshot(includeImage: false) {
            pane.lastViewport = snapshot.viewport
            pane.lastVisibleText = snapshot.visibleText
            pane.lastSelection = snapshot.selection ?? pane.lastSelection
            restoreViewport = snapshot.viewport
        } else if shouldRestoreViewport {
            restoreViewport = pane.lastViewport
        } else {
            restoreViewport = nil
        }
        let historyInfo = applyContentSet(frame: frame, to: pane, historyOwnerToken: historyOwnerToken)
        pane.currentTarget = nil

        pane.pendingFlushStrokes.removeAll()
        pane.firstPendingStrokeAt = nil
        pane.lastPendingStrokeAt = nil
        pane.lastSelection = nil
        pane.lastNavigationURL = nil
        pane.lastPage = nil
        pane.pendingSnapshotHintReason = pane.bridge == nil || frame.contentType == .html ? "after_render" : nil
        if let bridge = pane.bridge {
            bridge.render(entry: pane.currentEntry, restoreViewport: restoreViewport)
            noteRenderDiagnostics(
                surfaceId: surfaceId,
                pane: pane,
                bridgeAttached: true,
                status: "render_requested",
                message: nil
            )
        } else {
            noteRenderDiagnostics(
                surfaceId: surfaceId,
                pane: pane,
                bridgeAttached: false,
                status: "pending_renderer",
                message: "pane renderer not attached"
            )
        }
        restorePaneDrawing(surfaceId: surfaceId, pane: pane)
        if frame.contentType != .html, pane.bridge != nil {
            sendSnapshotHint(surfaceId: surfaceId, reason: "after_render")
        }

        var response = mutationAck(
            id: id,
            op: "content.apply",
            paneId: paneId,
            entry: pane.currentEntry,
            historyInfo: historyInfo
        )
        if var payloadObject = response["payload"] as? [String: Any],
           let topologyRevision = payload["topologyRevision"] as? Int {
            payloadObject["topologyRevision"] = topologyRevision
            payloadObject["render"] = pane.lastRenderDiagnostics.payload
            response["payload"] = payloadObject
        } else if var payloadObject = response["payload"] as? [String: Any] {
            payloadObject["render"] = pane.lastRenderDiagnostics.payload
            response["payload"] = payloadObject
        }
        return response
    }

    private func handleTargetApply(id: String, payload: [String: Any], connectionUUID: String) async -> [String: Any] {
        func result(
            requestId: String,
            targetId: String,
            paneLineageId: String,
            targetEpoch: Int,
            status: String,
            errorCode: String? = nil,
            message: String? = nil,
            materializedState: [String: Any]? = nil
        ) -> [String: Any] {
            var resultPayload: [String: Any] = [
                "requestId": requestId,
                "targetId": targetId,
                "paneLineageId": paneLineageId,
                "targetEpoch": targetEpoch,
                "status": status,
                "appliedAt": isoTimestampNow(),
            ]
            if let errorCode { resultPayload["errorCode"] = errorCode }
            if let message { resultPayload["message"] = message }
            if let materializedState { resultPayload["materializedState"] = materializedState }
            return [
                "v": 1,
                "type": "response",
                "op": "target.apply.result",
                "id": id,
                "ok": true,
                "sentAt": timestampNow(),
                "payload": resultPayload,
            ]
        }

        let requestId = payload["requestId"] as? String ?? ""
        let targetId = payload["targetId"] as? String ?? ""
        let paneLineageId = payload["paneLineageId"] as? String ?? ""
        let targetEpoch = payload["targetEpoch"] as? Int ?? 0
        guard let (surfaceId, _) = pairedSurface(for: connectionUUID) else {
            return makeErrorResponse(op: "target.apply", id: id, code: "not_paired", message: "pair.request required")
        }
        if activeSessions[surfaceId]?.sessionId != payload["ownershipSessionId"] as? String {
            return result(requestId: requestId, targetId: targetId, paneLineageId: paneLineageId, targetEpoch: targetEpoch, status: "rejected", errorCode: "ownership_session_mismatch", message: "target.apply ownershipSessionId does not match the active session")
        }
        if activeSessions[surfaceId]?.ownershipEpoch != payload["ownershipEpoch"] as? Int {
            return result(requestId: requestId, targetId: targetId, paneLineageId: paneLineageId, targetEpoch: targetEpoch, status: "rejected", errorCode: "ownership_epoch_mismatch", message: "target.apply ownershipEpoch does not match the active session")
        }
        return await materializeTargetApply(id: id, payload: payload, surfaceId: surfaceId)
    }

    private func materializeTargetApply(id: String, payload: [String: Any], surfaceId: String) async -> [String: Any] {
        func result(
            requestId: String,
            targetId: String,
            paneLineageId: String,
            targetEpoch: Int,
            status: String,
            errorCode: String? = nil,
            message: String? = nil,
            materializedState: [String: Any]? = nil
        ) -> [String: Any] {
            var resultPayload: [String: Any] = [
                "requestId": requestId,
                "targetId": targetId,
                "paneLineageId": paneLineageId,
                "targetEpoch": targetEpoch,
                "status": status,
                "appliedAt": isoTimestampNow(),
            ]
            if let errorCode { resultPayload["errorCode"] = errorCode }
            if let message { resultPayload["message"] = message }
            if let materializedState { resultPayload["materializedState"] = materializedState }
            return [
                "v": 1,
                "type": "response",
                "op": "target.apply.result",
                "id": id,
                "ok": true,
                "sentAt": timestampNow(),
                "payload": resultPayload,
            ]
        }

        let requestId = payload["requestId"] as? String ?? ""
        let targetId = payload["targetId"] as? String ?? ""
        let paneLineageId = payload["paneLineageId"] as? String ?? ""
        let targetEpoch = payload["targetEpoch"] as? Int ?? 0
        guard payload["targetKind"] as? String == "browser_url" else {
            return result(requestId: requestId, targetId: targetId, paneLineageId: paneLineageId, targetEpoch: targetEpoch, status: "rejected", errorCode: "unsupported_target_kind", message: "unsupported target kind")
        }
        guard let header = payload["targetHeader"] as? [String: Any],
              let requiredCapabilities = header["requiredCapabilities"] as? [String],
              requiredCapabilities == ["target.browser_url.v1"],
              header["replaySemantics"] as? String == "navigate" else {
            return result(requestId: requestId, targetId: targetId, paneLineageId: paneLineageId, targetEpoch: targetEpoch, status: "rejected", errorCode: "capability_missing", message: "required target capability is not advertised")
        }
        guard let pane = paneByLineage(surfaceId: surfaceId, paneLineageId: paneLineageId) else {
            return result(requestId: requestId, targetId: targetId, paneLineageId: paneLineageId, targetEpoch: targetEpoch, status: "rejected", errorCode: "pane_lineage_missing", message: "pane lineage is unknown")
        }
        guard !pane.annotationMode else {
            pane.toast = "Finish annotation (Done) to navigate"
            return result(requestId: requestId, targetId: targetId, paneLineageId: paneLineageId, targetEpoch: targetEpoch, status: "rejected", errorCode: "policy_denied", message: "annotation mode is active")
        }
        guard let targetPayload = payload["targetPayload"] as? [String: Any],
              let url = targetPayload["url"] as? String,
              safeBrowserURL(url) != nil else {
            return result(requestId: requestId, targetId: targetId, paneLineageId: paneLineageId, targetEpoch: targetEpoch, status: "rejected", errorCode: "unsafe_payload", message: "browser_url targetPayload.url must be http or https")
        }

        if !isVisibleEmptyEntry(pane.currentEntry) {
            pane.backStack.append(pane.currentEntry)
            trimVisibleHistory(pane)
        }
        pane.forwardStack.removeAll()
        pane.currentEntry = .browserURL(
            targetId: targetId,
            targetEpoch: targetEpoch,
            url: url,
            title: (payload["display"] as? [String: Any])?["title"] as? String,
            allowedSnapshotFallback: targetPayload["allowedSnapshotFallback"] as? Bool,
            fallbackSnapshotTargetId: targetPayload["fallbackSnapshotTargetId"] as? String
        )
        pane.currentEntry.provenanceDisplayName = SurfAceRuntime.provenanceDisplayName(
            from: payload["display"] as? [String: Any]
        )
        pane.pendingFlushStrokes.removeAll()
        pane.firstPendingStrokeAt = nil
        pane.lastPendingStrokeAt = nil
        pane.lastSelection = nil
        pane.lastNavigationURL = url
        pane.lastPage = nil
        pane.currentTarget = SurfAcePaneTargetState(
            targetId: targetId,
            targetKind: "browser_url",
            paneLineageId: paneLineageId,
            targetEpoch: targetEpoch,
            restorePolicy: payload["restoreReason"] as? String == "initial_apply" ? "confirm" : "auto",
            currentState: "current",
            lastApplyEvidence: nil
        )
        pane.pendingSnapshotHintReason = "after_render"
        let navigationResult = await (pane.bridge?.renderBrowserURL(entry: pane.currentEntry) ??
            SurfAceBrowserNavigationResult(errorMessage: "pane bridge is not attached", status: "failed", url: url))
        restorePaneDrawing(surfaceId: surfaceId, pane: pane)

        let resultPayload = Self.browserURLApplyResultPayload(
            requestId: requestId,
            targetId: targetId,
            paneLineageId: paneLineageId,
            targetEpoch: targetEpoch,
            url: navigationResult.url.isEmpty ? url : navigationResult.url,
            status: navigationResult.status,
            errorMessage: navigationResult.errorMessage,
            appliedAt: isoTimestampNow()
        )
        let response = [
            "v": 1,
            "type": "response",
            "op": "target.apply.result",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": resultPayload,
        ] as [String: Any]
        pane.currentTarget?.lastApplyEvidence = response["payload"] as? [String: Any]
        return response
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
              let newPaneLabels = payload["newPaneLabels"] as? [Int],
              count >= 2,
              newPaneIds.count == count - 1,
              newPaneLabels.count == count - 1,
              let _ = surface.panesById[paneId] else {
            return makeErrorResponse(op: "pane.split", id: id, code: "invalid_payload", message: "invalid pane.split payload")
        }

        for newPaneId in newPaneIds where surface.panesById[newPaneId] != nil {
            return makeErrorResponse(op: "pane.split", id: id, code: "invalid_payload", message: "newPaneIds must be unique")
        }
        var visiblePaneLabels = Set(surface.panesById.values.map(\.paneLabel))
        for newPaneLabel in newPaneLabels {
            guard newPaneLabel > 0, !visiblePaneLabels.contains(newPaneLabel) else {
                return makeErrorResponse(op: "pane.split", id: id, code: "invalid_payload", message: "duplicate or invalid paneLabel in surface payload")
            }
            visiblePaneLabels.insert(newPaneLabel)
        }
        let children: [SurfAcePaneLayoutNode] = [.leaf(paneId)] + newPaneIds.map { .leaf($0) }
        surface.activeKeyboardPaneId = paneId
        surface.paneLayout = surface.paneLayout.replacingLeaf(
            paneId: paneId,
            with: .split(direction: direction, children: children)
        )
        surface.topologyEpoch += 1

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
        persistSurfaceTopology(surfaceId: surfaceId)

        return [
            "v": 1,
            "type": "response",
            "op": "pane.split",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "panes": surface.panes.map { ["paneId": $0.paneId, "paneLineageId": $0.paneLineageId, "paneLabel": $0.paneLabel] },
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
        persistSurfaceTopology(surfaceId: surfaceId)
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
        surface.topologyEpoch += 1
        ensureActiveKeyboardPane(surface: surface)
        persistSurfaceTopology(surfaceId: surfaceId)

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
        let shouldRestoreViewport = shouldPreserveHTMLViewportAcrossContentSet(
            currentEntry: pane.currentEntry,
            incomingFrame: frame,
            historyOwnerToken: historyOwnerToken
        )
        let restoreViewport: SurfAceViewport?
        if shouldRestoreViewport,
           let snapshot = await pane.bridge?.fetchSnapshot(includeImage: false) {
            pane.lastViewport = snapshot.viewport
            pane.lastVisibleText = snapshot.visibleText
            pane.lastSelection = snapshot.selection ?? pane.lastSelection
            restoreViewport = snapshot.viewport
        } else if shouldRestoreViewport {
            restoreViewport = pane.lastViewport
        } else {
            restoreViewport = nil
        }
        let historyInfo = applyContentSet(frame: frame, to: pane, historyOwnerToken: historyOwnerToken)
        pane.currentTarget = nil

        pane.pendingFlushStrokes.removeAll()
        pane.firstPendingStrokeAt = nil
        pane.lastPendingStrokeAt = nil
        pane.lastSelection = nil
        pane.lastNavigationURL = nil
        pane.lastPage = nil
        pane.pendingSnapshotHintReason = frame.contentType == .html ? "after_render" : nil
        pane.bridge?.render(entry: pane.currentEntry, restoreViewport: restoreViewport)
        restorePaneDrawing(surfaceId: surfaceId, pane: pane)
        if frame.contentType != .html {
            sendSnapshotHint(surfaceId: surfaceId, reason: "after_render")
        }

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
        pane.bridge?.render(entry: pane.currentEntry, restoreViewport: nil)

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

        if !isVisibleEmptyEntry(pane.currentEntry) {
            pane.backStack.append(pane.currentEntry)
            trimVisibleHistory(pane)
        }
        pane.forwardStack.removeAll()
        pane.currentTarget = nil
        pane.currentEntry = .empty(revision: revision)
        pane.drawingRestoreWarningVisible = false
        pane.pendingFlushStrokes.removeAll()
        pane.firstPendingStrokeAt = nil
        pane.lastPendingStrokeAt = nil
        pane.bridge?.render(entry: nil, restoreViewport: nil)
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
            "currentTarget": jsonValue(targetStatePayload(pane.currentTarget)),
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

    private func handleAuthorityState(id: String, payload: [String: Any], connectionUUID: String) -> [String: Any] {
        guard let (surfaceId, surface) = pairedSurface(for: connectionUUID),
              var session = activeSessions[surfaceId],
              let ownershipLock = ownershipLocksBySurfaceId[surfaceId] else {
            return makeErrorResponse(op: "authority.state", id: id, code: "not_paired", message: "pair.request required")
        }

        let sessionIdentityMatches = payload["surfaceId"] as? String == surfaceId &&
            payload["providerId"] as? String == session.providerId &&
            payload["sessionId"] as? String == session.sessionId &&
            payload["ownershipEpoch"] as? Int == session.ownershipEpoch &&
            ownershipLock.providerId == session.providerId &&
            ownershipLock.sessionId == session.sessionId
        if sessionIdentityMatches,
           let providerWindowLabel = surfAceValidatedProviderWindowLabel(from: payload["windowLabel"]),
           providerWindowLabel != surface.windowLabel {
            applyProviderWindowLabel(surface: surface, windowLabel: providerWindowLabel)
        }

        let reason = surfAceAuthorityStateRejectionReason(
            payload: payload,
            surfaceId: surfaceId,
            providerId: session.providerId,
            sessionId: session.sessionId,
            ownershipEpoch: session.ownershipEpoch,
            lockProviderId: ownershipLock.providerId,
            lockSessionId: ownershipLock.sessionId,
            windowLabel: surface.windowLabel,
            panes: surface.panes.map {
                SurfAceAuthorityPaneIdentity(
                    paneId: $0.paneId,
                    paneLabel: $0.paneLabel,
                    paneLineageId: $0.paneLineageId
                )
            }
        )
        let accepted = reason == nil

        if accepted {
            session.authorityConfirmed = true
            activeSessions[surfaceId] = session
        } else {
            session.authorityConfirmed = false
            activeSessions[surfaceId] = session
        }
        refreshConnectionState(surfaceId: surfaceId)

        return [
            "v": 1,
            "type": "response",
            "op": "authority.state",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "accepted": accepted,
                "reason": reason.map { $0 as Any } ?? NSNull(),
            ],
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
        surfAceGatewayLog(
            "event=socket_terminated \(surfAceDiagnosticFields([("connection_uuid", connectionUUID), ("provider_id", pair.value.providerId), ("session_id", pair.value.sessionId), ("surface_id", surfaceId)]))"
        )
        activeSessions.removeValue(forKey: surfaceId)
        lastHeartbeatAtBySurfaceId.removeValue(forKey: surfaceId)
        surfaceById[surfaceId]?.providerName = nil
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
            && session.authorityConfirmed
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

    func resizeSplit(surfaceId: String, path: [Int], childIndex: Int, delta: CGFloat, extent: CGFloat) {
        guard let surface = surfaceById[surfaceId], extent > 0 else { return }
        let target = splitNode(at: path, in: surface.paneLayout)
        guard case .split(_, let children, _) = target,
              childIndex >= 0,
              childIndex + 1 < children.count else { return }
        let weights = children.map(\.layoutWeight)
        let total = max(weights.reduce(0, +), 1)
        let deltaWeight = Double(delta / extent) * total
        let pairTotal = weights[childIndex] + weights[childIndex + 1]
        let minimumWeight = min(max(0.05, total * 0.05), pairTotal / 2)
        let nextBefore = min(
            max(minimumWeight, weights[childIndex] + deltaWeight),
            max(minimumWeight, pairTotal - minimumWeight)
        )
        var nextWeights = weights
        nextWeights[childIndex] = nextBefore
        nextWeights[childIndex + 1] = max(minimumWeight, pairTotal - nextBefore)
        resizeSplit(surfaceId: surfaceId, path: path, weights: nextWeights)
    }

    func resizeSplit(surfaceId: String, path: [Int], weights: [Double]) {
        guard let surface = surfaceById[surfaceId] else { return }
        let target = splitNode(at: path, in: surface.paneLayout)
        guard case .split(_, let children, _) = target,
              weights.count == children.count else { return }
        surface.paneLayout = surface.paneLayout.updatingSplitWeights(path: path, weights: weights)
        surface.topologyEpoch += 1
        persistSurfaceTopology(surfaceId: surfaceId)
        sendLifecycleEvent(
            surfaceId: surfaceId,
            op: "event.topology_changed",
            payload: topologyChangedPayload(for: surface)
        )
    }

    private func splitNode(at path: [Int], in node: SurfAcePaneLayoutNode) -> SurfAcePaneLayoutNode {
        guard let first = path.first,
              case .split(_, let children, _) = node,
              children.indices.contains(first) else {
            return node
        }
        return splitNode(at: Array(path.dropFirst()), in: children[first])
    }

    private func noteRenderDiagnostics(
        surfaceId: String,
        pane: SurfAcePaneModel,
        bridgeAttached: Bool,
        status: String,
        message: String?
    ) {
        pane.lastRenderDiagnostics = SurfAceRenderDiagnostics(
            bridgeAttached: bridgeAttached,
            contentId: pane.currentEntry.contentId,
            contentType: pane.currentEntry.contentType,
            revision: pane.currentEntry.revision,
            status: status,
            message: message
        )
        surfAceLifecycleLog(
            "event=render_diagnostics \(surfAceDiagnosticFields([("surface_id", surfaceId), ("pane_id", pane.paneId), ("content_id", pane.currentEntry.contentId), ("content_type", pane.currentEntry.contentType?.rawValue), ("revision", pane.currentEntry.revision), ("bridge_attached", bridgeAttached), ("status", status), ("message", message)]))"
        )
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
        let shouldReplaceInPlace = !isVisibleEmptyEntry(pane.currentEntry)
            && pane.currentEntry.historyOwnerToken == historyOwnerToken

        if shouldReplaceInPlace {
            pane.currentEntry = nextEntry
            return nil
        }

        var historyInfo: [String: Any]?
        if !isVisibleEmptyEntry(pane.currentEntry) {
            let displacedEntry = pane.currentEntry
            pane.backStack.append(displacedEntry)
            trimVisibleHistory(pane)

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

    func shouldPreserveHTMLViewportAcrossContentSet(
        currentEntry: SurfAcePaneEntry,
        incomingFrame: SurfAceFrame,
        historyOwnerToken: String
    ) -> Bool {
        currentEntry.contentId != nil
            && currentEntry.contentType == .html
            && incomingFrame.contentType == .html
            && currentEntry.historyOwnerToken == historyOwnerToken
    }

    private func applyProviderBootstrapTopology(
        surface: SurfAceSurfaceModel,
        windowLabel: String,
        initialPaneId: Int,
        initialPaneLabel: Int
    ) {
        applyProviderWindowLabel(surface: surface, windowLabel: windowLabel)

        guard initialPaneId > 0, initialPaneLabel > 0, !surface.providerTopologyInitialized else {
            return
        }

        if case .leaf(let currentPaneId, _) = surface.paneLayout,
           let bootstrapPane = surface.panesById[currentPaneId] {
            if currentPaneId != initialPaneId {
                surface.panesById.removeValue(forKey: currentPaneId)
                bootstrapPane.paneId = initialPaneId
                surface.panesById[initialPaneId] = bootstrapPane
                surface.paneLayout = surface.paneLayout.replacingPaneID(from: currentPaneId, to: initialPaneId)
                surface.activeKeyboardPaneId = initialPaneId
                surface.topologyEpoch += 1
            }
            bootstrapPane.paneLabel = initialPaneLabel
        }
        surface.panesById[initialPaneId]?.paneLabel = initialPaneLabel
        ensureActiveKeyboardPane(surface: surface)
        surface.providerTopologyInitialized = true
        persistSurfaceTopology(surfaceId: surface.surfaceId)
    }

    private func applyProviderWindowLabel(surface: SurfAceSurfaceModel, windowLabel: String) {
        guard surface.windowLabel != windowLabel else { return }
        surface.windowLabel = windowLabel
        surface.name = "\(screenName) \(windowLabel.uppercased())"
        persistSurfaceTopology(surfaceId: surface.surfaceId)
    }

    private func ensureActiveKeyboardPane(surface: SurfAceSurfaceModel) {
        if let activePaneId = surface.activeKeyboardPaneId,
           surface.panesById[activePaneId] != nil {
            return
        }
        surface.activeKeyboardPaneId = surface.paneLayout.paneIDs.first
    }

    private func parseTopologyLayoutNode(
        _ payload: [String: Any],
        panesById: [Int: SurfAcePaneModel]
    ) -> SurfAcePaneLayoutNode? {
        guard let type = payload["type"] as? String else {
            return nil
        }

        switch type {
        case "pane":
            guard let paneId = payload["paneId"] as? Int,
                  panesById[paneId] != nil else {
                return nil
            }
            return .leaf(paneId, weight: payload["weight"] as? Double)
        case "split":
            guard let directionRaw = payload["direction"] as? String,
                  let direction = SurfAceLayoutDirection(rawValue: directionRaw),
                  let childrenPayload = payload["children"] as? [[String: Any]] else {
                return nil
            }
            let children = childrenPayload.compactMap { parseTopologyLayoutNode($0, panesById: panesById) }
            guard children.count == childrenPayload.count else {
                return nil
            }
            return .split(direction: direction, children: children, weight: payload["weight"] as? Double)
        default:
            return nil
        }
    }

    private func viewportPayload(for surface: SurfAceSurfaceModel) -> [String: Any] {
        [
            "width": max(Int(surface.viewportSize.width.rounded()), 1),
            "height": max(Int(surface.viewportSize.height.rounded()), 1),
            "scale": Double(max(surface.viewportScale, 1)),
        ]
    }

    private func topologyLayoutPayload(_ node: SurfAcePaneLayoutNode) -> [String: Any] {
        switch node {
        case .empty:
            return ["type": "split", "direction": "horizontal", "children": []]
        case .leaf(let paneId, let weight):
            var payload: [String: Any] = ["type": "pane", "paneId": paneId]
            if let weight { payload["weight"] = weight }
            return payload
        case .split(let direction, let children, let weight):
            var payload: [String: Any] = [
                "type": "split",
                "direction": direction.rawValue,
                "children": children.map(topologyLayoutPayload),
            ]
            if let weight { payload["weight"] = weight }
            return payload
        }
    }

    private func topologyChangedPayload(for surface: SurfAceSurfaceModel) -> [String: Any] {
        [
            "surfaceId": surface.surfaceId,
            "topologyRevision": max(surface.topologyEpoch, 1),
            "layout": topologyLayoutPayload(surface.paneLayout),
            "panes": surface.panes.map { pane in
                [
                    "paneId": pane.paneId,
                    "paneLabel": pane.paneLabel,
                    "name": jsonValue(pane.name),
                ]
            },
        ]
    }

    func paneViewportPayload(surfaceId: String, paneId: Int) -> [String: Any] {
        guard let surface = surfaceById[surfaceId],
              let pane = surface.panesById[paneId] else {
            return [
                "width": 1,
                "height": 1,
                "scale": 1,
            ]
        }
        guard let snapshot = currentPaneGeometrySnapshot(surface: surface, pane: pane) else {
            return viewportPayload(for: surface)
        }
        let rect = snapshot.contentViewport
        return [
            "width": max(Int(rect.width.rounded()), 1),
            "height": max(Int(rect.height.rounded()), 1),
            "scale": Double(max(snapshot.scale, 1)),
        ]
    }

    func paneGeometryPayload(surfaceId: String, paneId: Int) -> [String: Any] {
        guard let surface = surfaceById[surfaceId],
              let pane = surface.panesById[paneId] else {
            return fallbackPaneGeometryPayload(
                paneId: paneId,
                paneInstanceId: "",
                topologyEpoch: 0,
                surfaceEpoch: 0,
                scale: 1,
                surfaceBounds: CGRect(x: 0, y: 0, width: 1, height: 1)
            )
        }
        guard let snapshot = currentPaneGeometrySnapshot(surface: surface, pane: pane) else {
            return fallbackPaneGeometryPayload(
                paneId: paneId,
                paneInstanceId: pane.paneInstanceId,
                topologyEpoch: surface.topologyEpoch,
                surfaceEpoch: surface.surfaceEpoch,
                scale: surface.viewportScale,
                surfaceBounds: CGRect(origin: .zero, size: surface.viewportSize)
            )
        }
        let viewport = paneViewportPayload(surfaceId: surfaceId, paneId: paneId)
        return paneGeometryPayload(from: snapshot, viewport: viewport)
    }

    private func currentPaneGeometrySnapshot(surface: SurfAceSurfaceModel, pane: SurfAcePaneModel) -> SurfAcePaneGeometrySnapshot? {
        guard let snapshot = pane.geometrySnapshot,
              snapshot.topologyEpoch == surface.topologyEpoch,
              snapshot.surfaceEpoch == surface.surfaceEpoch else {
            return nil
        }
        return snapshot
    }

    private func paneGeometryPayload(from snapshot: SurfAcePaneGeometrySnapshot, viewport: [String: Any]) -> [String: Any] {
        [
            "paneId": snapshot.paneId,
            "paneInstanceId": snapshot.paneInstanceId,
            "topologyEpoch": snapshot.topologyEpoch,
            "surfaceEpoch": String(snapshot.surfaceEpoch),
            "geometryRevision": snapshot.geometryRevision,
            "coordinateSpace": snapshot.coordinateSpace,
            "surfaceBounds": rectPayload(snapshot.surfaceBounds),
            "paneFrame": rectPayload(snapshot.paneFrame),
            "contentViewport": rectPayload(snapshot.contentViewport),
            "protocolViewport": [
                "coordinateSpace": "protocol_viewport",
                "rect": rectPayload(snapshot.contentViewport),
                "viewport": viewport,
            ],
            "splitSpacingInsets": zeroInsetsPayload(),
            "safeAreaInsets": zeroInsetsPayload(),
            "scale": Double(max(snapshot.scale, 1)),
        ]
    }

    private func fallbackPaneGeometryPayload(
        paneId: Int,
        paneInstanceId: String,
        topologyEpoch: Int,
        surfaceEpoch: Int,
        scale: CGFloat,
        surfaceBounds: CGRect
    ) -> [String: Any] {
        let width = max(surfaceBounds.width, 1)
        let height = max(surfaceBounds.height, 1)
        let rect = CGRect(x: 0, y: 0, width: width, height: height)
        let viewport: [String: Any] = [
            "width": Int(width.rounded()),
            "height": Int(height.rounded()),
            "scale": Double(max(scale, 1)),
        ]
        return [
            "paneId": paneId,
            "paneInstanceId": paneInstanceId.isEmpty ? "unknown" : paneInstanceId,
            "topologyEpoch": topologyEpoch,
            "surfaceEpoch": String(surfaceEpoch),
            "geometryRevision": 0,
            "geometryUnavailable": true,
            "unavailableReason": "missing_resolved_snapshot",
            "coordinateSpace": SurfAcePaneGeometrySnapshot.coordinateSpace,
            "surfaceBounds": rectPayload(surfaceBounds),
            "paneFrame": rectPayload(rect),
            "contentViewport": rectPayload(rect),
            "protocolViewport": [
                "coordinateSpace": "protocol_viewport",
                "rect": rectPayload(rect),
                "viewport": viewport,
            ],
            "splitSpacingInsets": zeroInsetsPayload(),
            "safeAreaInsets": zeroInsetsPayload(),
            "scale": Double(max(scale, 1)),
        ]
    }

    private func rectPayload(_ rect: CGRect) -> [String: Any] {
        [
            "x": Double(rect.minX),
            "y": Double(rect.minY),
            "width": Double(rect.width),
            "height": Double(rect.height),
        ]
    }

    private func zeroInsetsPayload() -> [String: Any] {
        [
            "top": 0,
            "right": 0,
            "bottom": 0,
            "left": 0,
        ]
    }

    private func publishBonjour() {
        surfAceServerRuntimeLog(
            "event=bonjour_publish_request \(surfAceDiagnosticFields([("name", screenName), ("port", serverPort)]))"
        )
        bonjourPublisher.publish(name: screenName, port: serverPort, txtRecord: bonjourTXTRecord())
    }

    private func refreshBonjourTXT() {
        guard isStarted else { return }
        surfAceServerRuntimeLog(
            "event=bonjour_refresh \(surfAceDiagnosticFields([("busy", ownershipLocksBySurfaceId.isEmpty ? 0 : 1), ("surface_count", surfaces.count)]))"
        )
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
        guard let components = URLComponents(string: trimmed) else { return trimmed }
        return components.string ?? trimmed
    }

    private func isVisibleEmptyEntry(_ entry: SurfAcePaneEntry) -> Bool {
        entry.contentId == nil && entry.contentType == nil && entry.payload == nil && entry.url == nil
    }

    private func renderableEntry(_ entry: SurfAcePaneEntry) -> SurfAcePaneEntry? {
        isVisibleEmptyEntry(entry) ? nil : entry
    }

    private func trimVisibleHistory(_ pane: SurfAcePaneModel) {
        while pane.backStack.count + 1 + pane.forwardStack.count > 20 {
            if !pane.backStack.isEmpty {
                pane.backStack.removeFirst()
            } else if !pane.forwardStack.isEmpty {
                pane.forwardStack.removeLast()
            } else {
                break
            }
        }
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

    private func targetStatePayload(_ target: SurfAcePaneTargetState?) -> [String: Any]? {
        guard let target else { return nil }
        var payload: [String: Any] = [
            "targetId": target.targetId,
            "targetKind": target.targetKind,
            "paneLineageId": target.paneLineageId,
            "targetEpoch": target.targetEpoch,
            "restorePolicy": target.restorePolicy,
            "currentState": target.currentState,
        ]
        if let lastApplyEvidence = target.lastApplyEvidence {
            payload["lastApplyEvidence"] = lastApplyEvidence
        }
        return payload
    }

    static func browserURLApplyResultPayload(
        requestId: String,
        targetId: String,
        paneLineageId: String,
        targetEpoch: Int,
        url: String,
        status: String,
        errorMessage: String?,
        appliedAt: String
    ) -> [String: Any] {
        var payload: [String: Any] = [
            "requestId": requestId,
            "targetId": targetId,
            "paneLineageId": paneLineageId,
            "targetEpoch": targetEpoch,
            "status": status,
            "message": status == "applied" ? "browser_url navigation loaded" : errorMessage ?? "browser_url navigation failed",
            "materializedState": ["url": url, "replaySemantics": "navigate", "navigationStatus": status == "applied" ? "loaded" : "failed"],
            "appliedAt": appliedAt,
        ]
        if status != "applied" {
            payload["errorCode"] = "materialization_failed"
        }
        return payload
    }

    private func safeBrowserURL(_ value: String) -> URL? {
        guard let url = URL(string: value),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            return nil
        }
        return url
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
        guard let data = userDefaults.data(forKey: mappingStoreKey),
              let mapping = try? JSONDecoder().decode(SurfAceIdentityMapping.self, from: data) else {
            identityMapping = SurfAceIdentityMapping()
            return
        }
        identityMapping = mapping
    }

    private func persistIdentityMapping() {
        guard let data = try? JSONEncoder().encode(identityMapping) else { return }
        userDefaults.set(data, forKey: mappingStoreKey)
    }

    private func loadPersistedSurfaceTopologies() {
        guard let data = userDefaults.data(forKey: surfaceTopologyStoreKey),
              let mapping = try? JSONDecoder().decode([String: SurfAcePersistedSurfaceTopology].self, from: data) else {
            persistedSurfaceTopologies = [:]
            return
        }
        persistedSurfaceTopologies = mapping
    }

    func persistSurfaceTopology(surfaceId: String) {
        guard let surface = surfaceById[surfaceId] else { return }
        persistedSurfaceTopologies[surfaceId] = SurfAcePersistedSurfaceTopology(surface: surface)
        persistSurfaceTopologies()
    }

    private func persistSurfaceTopologies() {
        guard let data = try? JSONEncoder().encode(persistedSurfaceTopologies) else { return }
        userDefaults.set(data, forKey: surfaceTopologyStoreKey)
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

    private func isoTimestampNow() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    private func paneByLineage(surfaceId: String, paneLineageId: String) -> SurfAcePaneModel? {
        surfaceById[surfaceId]?.panes.first { $0.paneLineageId == paneLineageId }
    }

    private func startupFailureMessage(for error: Error) -> String {
        if case let NWError.posix(code) = error, code == .EADDRINUSE {
            return "Server failed after trying ports \(fixedServerPort)-\(fixedServerPort + SurfAceHTTPServer.fallbackPortOffsetLimit): port is already in use"
        }
        return "Server failed on fixed port \(fixedServerPort): \(error.localizedDescription)"
    }

    private static func provenanceDisplayName(from display: [String: Any]?) -> String? {
        if let senderDisplayName = display?["senderDisplayName"] as? String,
           !senderDisplayName.isEmpty {
            return senderDisplayName
        }
        guard let provenance = display?["provenance"] as? [String: Any] else { return nil }
        if let displayName = provenance["displayName"] as? String,
           !displayName.isEmpty {
            return displayName
        }
        if let streamLabel = provenance["streamLabel"] as? String,
           !streamLabel.isEmpty {
            return streamLabel
        }
        return nil
    }
}

#if DEBUG
extension SurfAceRuntime {
    func targetCapabilitiesForTesting() -> [String] {
        targetCapabilities
    }

    func materializeTargetApplyForTesting(id: String, payload: [String: Any], surfaceId: String) async -> [String: Any] {
        await materializeTargetApply(id: id, payload: payload, surfaceId: surfaceId)
    }

    func contentApplyForTesting(id: String, payload: [String: Any], surfaceId: String) async -> [String: Any] {
        await handleContentApply(id: id, payload: payload, surfaceId: surfaceId)
    }
}
#endif

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
