import CryptoKit
import Foundation
import Observation
import Network
import UIKit

struct SurfAceLocklessProtocolError: Equatable, Sendable {
    var code: String
    var details: [String: Int64]
    var message: String
    var targetErrorCode: String?

    init(
        code: String,
        details: [String: Int64],
        message: String,
        targetErrorCode: String? = nil
    ) {
        self.code = code
        self.details = details
        self.message = message
        self.targetErrorCode = targetErrorCode
    }
}

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

private func surfAceFlightRecorderLogPath() -> String {
    let applicationSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    return applicationSupport
        .appendingPathComponent("SurfAce", isDirectory: true)
        .appendingPathComponent("client-flight-recorder.log")
        .path
}

private func surfAceFlightRecorderTail(maxLines: Int = 240) -> [String] {
    let path = surfAceFlightRecorderLogPath()
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return [] }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    return Array(lines.suffix(max(1, maxLines)))
}

private func surfAceTrimFlightRecorder(maxLines: Int = 512) {
    let path = surfAceFlightRecorderLogPath()
    guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { return }
    let lines = text.split(separator: "\n", omittingEmptySubsequences: true).map(String.init)
    guard lines.count > maxLines else { return }
    let trimmed = lines.suffix(maxLines).joined(separator: "\n") + "\n"
    try? trimmed.write(toFile: path, atomically: true, encoding: .utf8)
}

private func surfAceSimulatorTailCommand() -> String {
    "APPDATA=$(xcrun simctl get_app_container booted co.clicketyclacks.SurfAce data); tail -n 200 \"$APPDATA/Library/Application Support/SurfAce/client-flight-recorder.log\""
}

private func surfAceDeviceCollectCommand() -> String {
    "Xcode Devices and Simulators > select device > SurfAce > Download Container; inspect AppData/Library/Application Support/SurfAce/client-flight-recorder.log"
}

private func surfAceRecordFlight(scope: String, message: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) [surf-ace:\(scope)] \(message)\n"
    let url = URL(fileURLWithPath: surfAceFlightRecorderLogPath())
    do {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = line.data(using: .utf8) {
            if FileManager.default.fileExists(atPath: url.path),
               let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                try handle.seekToEnd()
                try handle.write(contentsOf: data)
            } else {
                try data.write(to: url, options: .atomic)
            }
        }
    } catch {
        // Diagnostics must never change Surf Ace runtime behavior.
    }
    surfAceTrimFlightRecorder()
    print("[SurfAce-Client] \(message)")
}

private func surfAcePersistRetentionDiagnostic(_ message: String) throws {
    let line = "\(ISO8601DateFormatter().string(from: Date())) [surf-ace:lifecycle] \(message)\n"
    let url = URL(fileURLWithPath: surfAceFlightRecorderLogPath())
    try FileManager.default.createDirectory(
        at: url.deletingLastPathComponent(), withIntermediateDirectories: true
    )
    let data = Data(line.utf8)
    if FileManager.default.fileExists(atPath: url.path) {
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: data)
        try handle.synchronize()
    } else {
        try data.write(to: url, options: .atomic)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }
        try handle.synchronize()
    }
    surfAceTrimFlightRecorder()
}

private func surfAceServerRuntimeLog(_ message: String) {
    surfAceRecordFlight(scope: "server", message: message)
    print("[SurfAce-Server] \(message)")
}

private func surfAceGatewayLog(_ message: String) {
    surfAceRecordFlight(scope: "gateway", message: message)
    print("[SurfAce-Gateway] \(message)")
}

private func surfAceLifecycleLog(_ message: String) {
    surfAceRecordFlight(scope: "lifecycle", message: message)
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
    let paneLineageId: String
}

func surfAceValidatedProviderNewPaneLabels(from value: Any?, count: Int) -> [Int]? {
    guard count >= 2,
          let labels = value as? [Int],
          labels.count == count - 1 else {
        return nil
    }
    return labels
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
    guard surfAceProviderAuthorityPaneIdentityMap(from: payload, matching: panes) != nil else {
        return "pane_identity_mismatch"
    }
    if payload["actionable"] as? Bool != true {
        return payload["reason"] as? String ?? "provider_not_actionable"
    }
    return nil
}

func surfAceProviderAuthorityPaneIdentityMap(
    from payload: [String: Any],
    matching panes: [SurfAceAuthorityPaneIdentity]
) -> [Int: SurfAceAuthorityPaneIdentity]? {
    guard let payloadPanes = payload["panes"] as? [[String: Any]],
          payloadPanes.count == panes.count else {
        return nil
    }
    let paneIds = Set(panes.map { $0.paneId })
    var seenPaneIds = Set<Int>()
    var seenPaneLabels = Set<Int>()
    var identitiesByPaneId: [Int: SurfAceAuthorityPaneIdentity] = [:]
    for candidate in payloadPanes {
        guard let paneId = candidate["paneId"] as? Int,
              seenPaneIds.insert(paneId).inserted,
              paneIds.contains(paneId),
              let paneLabel = candidate["paneLabel"] as? Int,
              paneLabel > 0,
              seenPaneLabels.insert(paneLabel).inserted,
              let paneLineageId = candidate["paneLineageId"] as? String,
              !paneLineageId.isEmpty else {
            return nil
        }
        identitiesByPaneId[paneId] = SurfAceAuthorityPaneIdentity(
            paneId: paneId,
            paneLabel: paneLabel,
            paneLineageId: paneLineageId
        )
    }
    return identitiesByPaneId
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
    private let prepareSend: (@Sendable (String, Priority) async -> Void)?
    private var queue: [QueuedSend] = []
    private var nextSequence = 0
    private var isDraining = false

    init(
        socket: SurfAceWebSocket,
        prepareSend: (@Sendable (String, Priority) async -> Void)? = nil
    ) {
        self.socket = socket
        self.prepareSend = prepareSend
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
                if let prepareSend {
                    await prepareSend(next.text, next.priority)
                }
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
    let postSendAction: (@MainActor () async -> Void)?

    init(
        responseObject: [String: Any],
        postSendPairCommit: SurfAcePairCommitPlan?,
        postSendAction: (@MainActor () async -> Void)? = nil
    ) {
        self.responseObject = responseObject
        self.postSendPairCommit = postSendPairCommit
        self.postSendAction = postSendAction
    }
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
    nonisolated static func locklessProtocolError(
        for error: SurfAceLocklessRuntimeAdapterError
    ) -> SurfAceLocklessProtocolError {
        switch error {
        case .receiptCapacity(
            let currentBytes,
            let currentCount,
            let prospectiveBytes,
            let prospectiveCount,
            let maxBytes,
            let maxCount
        ):
            return SurfAceLocklessProtocolError(
                code: "receipt_capacity",
                details: [
                    "currentBytes": currentBytes,
                    "currentCount": currentCount,
                    "maxBytes": maxBytes,
                    "maxCount": maxCount,
                    "prospectiveBytes": prospectiveBytes,
                    "prospectiveCount": prospectiveCount,
                ],
                message: "Pending operation receipt ledger is at capacity"
            )
        case .surfaceStateCapacity(let current, let prospective, let maximum):
            return SurfAceLocklessProtocolError(
                code: "surface_state_capacity",
                details: [
                    "currentBytes": current,
                    "maximumBytes": maximum,
                    "prospectiveBytes": prospective,
                ],
                message: "Target apply work item exceeds surface recoverable base capacity"
            )
        case .targetPrecommit(let code, let targetErrorCode, let message):
            return SurfAceLocklessProtocolError(
                code: code,
                details: [:],
                message: message,
                targetErrorCode: targetErrorCode
            )
        default:
            return SurfAceLocklessProtocolError(
                code: "invalid_payload",
                details: [:],
                message: String(describing: error)
            )
        }
    }

    private let fixedServerPort: UInt16 = 19_001
    var screenName: String
    var fingerprint: String
    var instanceDisambiguator: String
    var serverPort: Int = 0
    var endpointError: String?
    var surfaces: [SurfAceSurfaceModel] = []
    var isSceneAuthorityReady = false

    @ObservationIgnored private let server = SurfAceHTTPServer()
    @ObservationIgnored private let bonjourPublisher = SurfAceBonjourPublisher()
    @ObservationIgnored private let identityStore = SurfAceIdentityStore()
    @ObservationIgnored private let mappingStoreKey = "SurfAce.SurfaceIdentityMapping"
    @ObservationIgnored private let surfaceTopologyStoreKey = "SurfAce.SurfaceTopologyMapping"
    @ObservationIgnored private let userDefaults: UserDefaults
    @ObservationIgnored private let locklessStateURLOverride: URL?
    @ObservationIgnored private let outboundSendPreparation: (@Sendable (
        String, SurfAceOutboundSender.Priority
    ) async -> Void)?
    @ObservationIgnored private let locklessDeliveryWaitObserver: (@Sendable () -> Void)?
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
    @ObservationIgnored private var locklessAdapter: SurfAceLocklessRuntimeAdapter?
    @ObservationIgnored private var legacyNegotiatedSurfaceIds: Set<String> = []
    @ObservationIgnored private var locklessConnectionsByConnectionUUID: [String: (
        controllerInstanceId: String,
        sender: SurfAceOutboundSender,
        socket: SurfAceWebSocket
    )] = [:]
    @ObservationIgnored private var locklessDeliveryActive = false
    @ObservationIgnored private var locklessDeliveryWaiters: [CheckedContinuation<Void, Never>] = []
    @ObservationIgnored private var locklessAdmissionDeliveryBarriers: Set<String> = []

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
    let targetCapabilities = surfAceTargetCapabilities
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

    init(
        userDefaults: UserDefaults = .standard,
        locklessStateURL: URL? = nil,
        outboundSendPreparation: (@Sendable (
            String, SurfAceOutboundSender.Priority
        ) async -> Void)? = nil,
        locklessDeliveryWaitObserver: (@Sendable () -> Void)? = nil
    ) {
        self.userDefaults = userDefaults
        self.locklessStateURLOverride = locklessStateURL
        self.outboundSendPreparation = outboundSendPreparation
        self.locklessDeliveryWaitObserver = locklessDeliveryWaitObserver
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
            "event=runtime_init \(surfAceDiagnosticFields([("device_collect_command", surfAceDeviceCollectCommand()), ("fingerprint", fingerprint), ("log_path", surfAceFlightRecorderLogPath()), ("screen_name", screenName), ("simulator_tail_command", surfAceSimulatorTailCommand())]))"
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
        await restoreLocklessAuthority(reason: "process_start")
        isSceneAuthorityReady = true
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
            surfAceServerRuntimeLog(
                "event=selected_provider_endpoint \(surfAceDiagnosticFields([("endpoint_address", "0.0.0.0:\(serverPort)"), ("health_path", healthPath), ("screen_name", screenName), ("ws_path", webSocketPath)]))"
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
        await closeLocklessConnectionsForLifecycle(reason: "provider_shutdown")
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
        let restoreAttemptId = randomHex(prefix: "ra", byteCount: 8)
        let persistedPaneCount = persistedSurfaceTopologies[surfaceId]?.panes.count ?? 0
        let persistedContentCount = persistedSurfaceTopologies[surfaceId]?.panes.filter { $0.currentEntry?.contentId != nil }.count ?? 0
        ensureActiveKeyboardPane(surface: surface)
        surfaceById[surfaceId] = surface
        surfaceIdBySceneKey[sceneKey] = surfaceId
        surfaces.append(surface)
        persistSurfaceTopology(surfaceId: surfaceId)
        surfAceLifecycleLog(
            "event=scene_connect \(surfAceDiagnosticFields([("persisted_content_count", persistedContentCount), ("persisted_pane_count", persistedPaneCount), ("restored_topology", persistedSurfaceTopologies[surfaceId] != nil), ("restore_attempt_id", restoreAttemptId), ("scene_key", sceneKey), ("surface_id", surfaceId)]))"
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
        removeSurfaceModel(sceneKey: sceneKey, persistLegacyProjection: true)
    }

    func registerSurfaceForScene(sceneKey: String, scene: UIScene? = nil) async -> SurfAceSurfaceModel? {
        if let surfaceId = identityMapping.surfacesBySceneKey[sceneKey]?.surfaceId,
           legacyNegotiatedSurfaceIds.contains(surfaceId) {
            return registerSurface(sceneKey: sceneKey, scene: scene)
        }
        guard let adapter = locklessAdapter else {
            return registerSurface(sceneKey: sceneKey, scene: scene)
        }
        if let scene {
            ensureSceneDisconnectObservation(sceneKey: sceneKey, scene: scene)
        }
        do {
            let commit = try await commitLocalMutation(adapter: adapter, operation: "local.surface.restore") { state, sequence in
                let surfaceId: String
                if let mappedSurfaceId = state.sceneSurfaceIds[sceneKey],
                   var live = state.liveSurfaces[mappedSurfaceId] {
                    if !live.sceneKeys.contains(sceneKey) {
                        live.sceneKeys.append(sceneKey)
                        live.sceneKeys.sort()
                        live.surfaceRevision += 1
                        state.liveSurfaces[mappedSurfaceId] = live
                    }
                    surfaceId = mappedSurfaceId
                } else if let mappedSurfaceId = state.sceneSurfaceIds[sceneKey],
                          let tombstone = state.surfaceTombstones.first(where: {
                              $0.surface.surfaceId == mappedSurfaceId
                          }) {
                    let restoredResult = try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
                        state: &state,
                        tombstoneId: tombstone.tombstoneId,
                        expectedSurfaceSetRevision: state.surfaceSetRevision,
                        placement: .object(["sceneKey": .string(sceneKey)])
                    )
                    var restored = restoredResult.surface
                    if !restored.sceneKeys.contains(sceneKey) {
                        restored.sceneKeys.append(sceneKey)
                        restored.sceneKeys.sort()
                    }
                    restored.surfaceRevision += 1
                    state.liveSurfaces[mappedSurfaceId] = restored
                    surfaceId = mappedSurfaceId
                } else if var pending = state.liveSurfaces.values
                    .filter({ $0.sceneKeys.isEmpty })
                    .sorted(by: { $0.surfaceId < $1.surfaceId })
                    .first {
                    pending.sceneKeys = [sceneKey]
                    pending.surfaceRevision += 1
                    state.liveSurfaces[pending.surfaceId] = pending
                    state.sceneSurfaceIds[sceneKey] = pending.surfaceId
                    surfaceId = pending.surfaceId
                } else {
                    let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
                        state: &state,
                        expectedSurfaceSetRevision: state.surfaceSetRevision,
                        placement: .object(["sceneKey": .string(sceneKey)])
                    )
                    surfaceId = opened.surface.surfaceId
                    var surface = opened.surface
                    surface.sceneKeys = [sceneKey]
                    surface.surfaceRevision += 1
                    state.liveSurfaces[surfaceId] = surface
                    state.sceneSurfaceIds[sceneKey] = surfaceId
                }
                return .object([
                    "commitSequence": .integer(sequence),
                    "surfaceId": .string(surfaceId),
                ])
            }
            let readiness = await adapter.readinessSnapshot()
            try projectLocklessAuthorityState(readiness.state, connectedSceneKey: sceneKey)
            guard case .object(let result) = commit.result,
                  case .string(let surfaceId) = result["surfaceId"],
                  let surface = surfaceById[surfaceId] else {
                throw SurfAceLocklessAuthorityError.invalidState("scene_projection")
            }
            let recovered = try await adapter.recoverTargetWork(surfaceId: surfaceId) { [weak self] work in
                guard let self else {
                    return SurfAceLocklessMaterializationOutcome(
                        errorCode: "materialization_failed", materializedState: nil, status: "failed"
                    )
                }
                return await self.materializeLocklessTargetWork(work)
            }
            if !recovered.isEmpty {
                try projectLocklessAuthorityState(await adapter.snapshot())
                for result in recovered {
                    await fanoutLocklessTargetResult(result)
                }
            }
            surfAceLifecycleLog(
                "event=lockless_scene_restore_commit \(surfAceDiagnosticFields([("scene_key", sceneKey), ("surface_id", surfaceId)]))"
            )
            await fanoutLocklessCommittedEvent(
                op: "event.surface_appeared",
                payload: .object(["surfaceId": .string(surfaceId)])
            )
            await drainControllerRetentionReclamations(adapter: adapter)
            refreshBonjourTXT()
            return surface
        } catch {
            endpointError = "Lockless scene restore failed: \(error.localizedDescription)"
            return nil
        }
    }

    func unregisterSurfaceForScene(sceneKey: String) async {
        if let surfaceId = surfaceIdBySceneKey[sceneKey],
           legacyNegotiatedSurfaceIds.contains(surfaceId) {
            unregisterSurface(sceneKey: sceneKey)
            return
        }
        guard let adapter = locklessAdapter,
              let surfaceId = surfaceIdBySceneKey[sceneKey] else {
            unregisterSurface(sceneKey: sceneKey)
            return
        }
        do {
            _ = try await commitLocalMutation(adapter: adapter, operation: "local.surface.close") { state, sequence in
                guard let surface = state.liveSurfaces[surfaceId] else {
                    return .object(["commitSequence": .integer(sequence), "surfaceId": .string(surfaceId)])
                }
                let result = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
                    state: &state,
                    surfaceId: surfaceId,
                    expectedSurfaceSetRevision: state.surfaceSetRevision,
                    expectedTopologyRevision: surface.topologyRevision
                )
                state.sceneSurfaceIds[sceneKey] = surfaceId
                return .object([
                    "commitSequence": .integer(sequence),
                    "surfaceId": .string(surfaceId),
                    "tombstoneId": .string(result.tombstoneId),
                ])
            }
            removeSurfaceModel(sceneKey: sceneKey, persistLegacyProjection: false)
            await fanoutLocklessCommittedEvent(
                op: "event.surface_removed",
                payload: .object(["surfaceId": .string(surfaceId)])
            )
            await drainControllerRetentionReclamations(adapter: adapter)
            surfAceLifecycleLog(
                "event=lockless_scene_close_commit \(surfAceDiagnosticFields([("scene_key", sceneKey), ("surface_id", surfaceId)]))"
            )
        } catch {
            endpointError = "Lockless scene close failed: \(error.localizedDescription)"
        }
    }

    @discardableResult
    func closePaneLocally(surfaceId: String, paneId: Int) async throws -> String {
        let adapter = try locklessAuthorityForLocalMutation()
        let removedPane = pane(surfaceId: surfaceId, paneId: paneId)
        let commit = try await commitLocalMutation(adapter: adapter, operation: "local.pane.close") { state, sequence in
            guard let surface = state.liveSurfaces[surfaceId] else {
                throw SurfAceLocklessTopologyOperationError.surfaceNotFound(surfaceId)
            }
            let result = try SurfAceLocklessTopologyOperations.paneClose(
                state: &state,
                surfaceId: surfaceId,
                paneId: Int64(paneId),
                expectedTopologyRevision: surface.topologyRevision
            )
            return .object([
                "commitSequence": .integer(sequence),
                "paneId": .integer(result.paneId),
                "surfaceId": .string(surfaceId),
                "tombstoneId": .string(result.tombstoneId),
                "topologyRevision": .integer(result.topologyRevision),
            ])
        }
        guard case .object(let result) = commit.result,
              case .string(let tombstoneId) = result["tombstoneId"] else {
            throw SurfAceLocklessAuthorityError.invalidState("local_pane_close_result")
        }
        try projectLocklessAuthorityState(await adapter.snapshot())
        removedPane?.pendingFlushTask?.cancel()
        removedPane?.pendingFlushTask = nil
        await fanoutLocklessCommittedEvent(
            op: "event.pane_removed",
            payload: .object([
                "paneId": .integer(Int64(paneId)),
                "surfaceId": .string(surfaceId),
                "tombstoneId": .string(tombstoneId),
            ])
        )
        await drainControllerRetentionReclamations(adapter: adapter)
        return tombstoneId
    }

    @discardableResult
    func restorePaneLocally(
        surfaceId: String,
        tombstoneId: String,
        anchorPaneId: Int,
        direction: String
    ) async throws -> Int {
        let adapter = try locklessAuthorityForLocalMutation()
        let commit = try await commitLocalMutation(adapter: adapter, operation: "local.pane.restore") { state, sequence in
            guard let surface = state.liveSurfaces[surfaceId] else {
                throw SurfAceLocklessTopologyOperationError.surfaceNotFound(surfaceId)
            }
            let result = try SurfAceLocklessTopologyOperations.paneRestore(
                state: &state,
                surfaceId: surfaceId,
                tombstoneId: tombstoneId,
                anchorPaneId: Int64(anchorPaneId),
                direction: direction,
                expectedTopologyRevision: surface.topologyRevision
            )
            return .object([
                "commitSequence": .integer(sequence),
                "paneId": .integer(result.paneId),
                "paneLabel": .integer(result.paneLabel),
                "surfaceId": .string(surfaceId),
                "tombstoneId": .string(tombstoneId),
                "topologyRevision": .integer(result.topologyRevision),
            ])
        }
        guard case .object(let result) = commit.result,
              case .integer(let paneId) = result["paneId"] else {
            throw SurfAceLocklessAuthorityError.invalidState("local_pane_restore_result")
        }
        try projectLocklessAuthorityState(await adapter.snapshot())
        await fanoutLocklessCommittedEvent(
            op: "event.pane_created",
            payload: .object([
                "paneId": .integer(paneId),
                "surfaceId": .string(surfaceId),
                "tombstoneId": .string(tombstoneId),
            ])
        )
        await drainControllerRetentionReclamations(adapter: adapter)
        return Int(paneId)
    }

    private func removeSurfaceModel(sceneKey: String, persistLegacyProjection: Bool) {
        sceneDisconnectObserversBySceneKey.removeValue(forKey: sceneKey)?.invalidate()
        guard let surfaceId = surfaceIdBySceneKey.removeValue(forKey: sceneKey),
              let surface = surfaceById.removeValue(forKey: surfaceId) else {
            return
        }

        if persistLegacyProjection {
            persistedSurfaceTopologies[surfaceId] = SurfAcePersistedSurfaceTopology(surface: surface)
            persistSurfaceTopologies()
        }
        surfAceLifecycleLog(
            "event=scene_disconnect \(surfAceDiagnosticFields([("pane_count", surface.panes.count), ("scene_key", sceneKey), ("surface_id", surfaceId)]))"
        )
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

    func restoreLocklessAuthority(reason: String) async {
        guard SurfAceLocklessTargetAdmission.platformPermitsLockless else { return }
        do {
            let adapter = try locklessAuthorityForLocalMutation()
            let recovered = try await adapter.recoverTargetWork { [weak self] work in
                guard let self else {
                    return SurfAceLocklessMaterializationOutcome(
                        errorCode: "materialization_failed", materializedState: nil, status: "failed"
                    )
                }
                return await self.materializeLocklessTargetWork(work)
            }
            let readiness = await adapter.readinessSnapshot()
            guard readiness.fullGenerationLoaded else {
                throw SurfAceLocklessAuthorityError.invalidState("generation_not_loaded")
            }
            guard readiness.targetWorkRecovered else {
                throw SurfAceLocklessAuthorityError.invalidState("target_work_not_recovered")
            }
            applyNegotiatedModes(readiness.state)
            try projectLocklessAuthorityState(readiness.state)
            for result in recovered {
                await fanoutLocklessTargetResult(result)
                await fanoutLocklessConsumable(
                    scopeId: Self.locklessSurfaceScopeId(result.surfaceId), adapter: adapter
                )
            }
            await drainControllerRetentionReclamations(adapter: adapter)
            surfAceLifecycleLog(
                "event=lockless_authority_restored \(surfAceDiagnosticFields([("generation", readiness.state.generation), ("reason", reason), ("target_work_recovered", readiness.targetWorkRecovered)]))"
            )
        } catch {
            endpointError = "Lockless authority restore failed: \(error.localizedDescription)"
            surfAceLifecycleLog(
                "event=lockless_authority_restore_failed \(surfAceDiagnosticFields([("error", error.localizedDescription), ("reason", reason)]))"
            )
        }
    }

    private func projectLocklessAuthorityState(
        _ state: SurfAceLocklessAuthorityState,
        connectedSceneKey: String? = nil
    ) throws {
        let preview = try SurfAceLocklessMigration.rollbackPreview(state)
        var topologies = try JSONDecoder().decode(
            [String: SurfAcePersistedSurfaceTopology].self,
            from: preview.projection.surfaceTopologies
        )
        for (surfaceId, authoritySurface) in state.liveSurfaces {
            topologies[surfaceId]?.paneLayout = try persistedPaneLayout(
                fromCanonical: authoritySurface.topology
            )
        }

        if let connectedSceneKey,
           let surfaceId = state.sceneSurfaceIds[connectedSceneKey],
           let topology = topologies[surfaceId],
           surfaceById[surfaceId] == nil {
            let surface = SurfAceSurfaceModel(
                sceneKey: connectedSceneKey,
                surfaceId: surfaceId,
                windowLabel: topology.windowLabel,
                name: topology.name
            )
            topology.apply(to: surface)
            ensureActiveKeyboardPane(surface: surface)
            surfaceById[surfaceId] = surface
            surfaceIdBySceneKey[connectedSceneKey] = surfaceId
            surfaces.append(surface)
        }

        for surface in surfaces where !legacyNegotiatedSurfaceIds.contains(surface.surfaceId) {
            guard let topology = topologies[surface.surfaceId] else { continue }
            project(topology: topology, onto: surface)
            if let authoritySurface = state.liveSurfaces[surface.surfaceId] {
                surface.topologyEpoch = Int(authoritySurface.topologyRevision)
                surface.surfaceEpoch = Int(authoritySurface.surfaceRevision)
            }
        }
    }

    private func project(
        topology: SurfAcePersistedSurfaceTopology,
        onto surface: SurfAceSurfaceModel
    ) {
        surface.windowLabel = topology.windowLabel
        surface.name = topology.name
        let projectedPaneIds = Set(topology.panes.map(\.paneId))
        for persistedPane in topology.panes {
            let pane = surface.panesById[persistedPane.paneId] ?? persistedPane.makePane()
            pane.paneLabel = persistedPane.paneLabel
            pane.paneLineageId = persistedPane.paneLineageId
            pane.name = persistedPane.name
            pane.annotationMode = persistedPane.annotationMode ?? false
            pane.backStack = persistedPane.backStack ?? []
            pane.currentEntry = persistedPane.currentEntry ?? .empty()
            pane.forwardStack = persistedPane.forwardStack ?? []
            pane.currentTarget = persistedPane.currentTarget
            surface.panesById[persistedPane.paneId] = pane
        }
        surface.panesById = surface.panesById.filter { projectedPaneIds.contains($0.key) }
        surface.paneLayout = topology.paneLayout.runtimeNode
        ensureActiveKeyboardPane(surface: surface)
    }

    nonisolated private static func locklessJSON<T: Encodable>(_ value: T) throws -> SurfAceLocklessJSON {
        try JSONDecoder().decode(SurfAceLocklessJSON.self, from: JSONEncoder().encode(value))
    }

    private func ensureSceneDisconnectObservation(sceneKey: String, scene: UIScene) {
        if let observer = sceneDisconnectObserversBySceneKey[sceneKey] {
            observer.observe(sceneObject: scene)
            return
        }

        let observer = SurfAceSceneDisconnectObserver { [weak self] in
            Task { @MainActor in
                await self?.unregisterSurfaceForScene(sceneKey: sceneKey)
            }
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
        surfAceLifecycleLog(
            "event=pane_bridge_attach \(surfAceDiagnosticFields([("content_id", pane.currentEntry.contentId), ("content_type", pane.currentEntry.contentType?.rawValue), ("pane_id", paneId), ("revision", pane.currentEntry.revision), ("surface_id", surfaceId)]))"
        )
        noteRenderDiagnostics(
            surfaceId: surfaceId,
            pane: pane,
            bridgeAttached: true,
            status: pane.currentEntry.contentId == nil ? "standby_rendered" : "render_requested",
            message: nil
        )
        restorePaneDrawing(surfaceId: surfaceId, pane: pane)
        bridge.setContentScale(pane.contentScale)
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
        if let adapter = locklessAdapter, !legacyNegotiatedSurfaceIds.contains(surfaceId) {
            Task { @MainActor in
                await commitLocalAnnotationMode(
                    adapter: adapter,
                    surfaceId: surfaceId,
                    paneId: paneId,
                    enabled: enabled,
                    fingerDrawEnabled: fingerDrawEnabled,
                    source: source
                )
            }
            return
        }
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
            clearPaneDrawings(pane)
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
        if let adapter = locklessAdapter, !legacyNegotiatedSurfaceIds.contains(surfaceId) {
            Task { @MainActor in
                await commitLocalHistoryNavigation(
                    adapter: adapter,
                    surfaceId: surfaceId,
                    paneId: paneId,
                    direction: direction
                )
            }
            return
        }
        guard let originalPane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        activateKeyboardPane(surfaceId: surfaceId, paneId: paneId)
        guard !originalPane.annotationMode else {
            originalPane.toast = "Finish annotation (Done) to navigate"
            return
        }

        switch direction {
        case .back:
            guard let previous = originalPane.backStack.popLast() else { return }
            originalPane.forwardStack.append(originalPane.currentEntry)
            originalPane.currentEntry = previous
        case .forward:
            guard let next = originalPane.forwardStack.popLast() else { return }
            originalPane.backStack.append(originalPane.currentEntry)
            originalPane.currentEntry = next
        }

        originalPane.bridge?.render(entry: renderableEntry(originalPane.currentEntry), restoreViewport: nil)
        restorePaneDrawing(surfaceId: surfaceId, pane: originalPane)
        originalPane.lastNavigationURL = originalPane.currentEntry.url
        UIAccessibility.post(
            notification: .announcement,
            argument: originalPane.currentCompositeProvenance().accessibilityLabel
        )
        if eventIsEnabled(surfaceId: surfaceId, eventName: "event.history_navigated") {
            sendEvent(
                surfaceId: surfaceId,
                op: "event.history_navigated",
                payload: [
                    "paneId": paneId,
                    "contentId": jsonValue(originalPane.currentEntry.contentId),
                    "revision": originalPane.currentEntry.revision,
                    "direction": direction == .back ? "back" : "forward",
                ]
            )
        }
    }

    private func commitLocalHistoryNavigation(
        adapter: SurfAceLocklessRuntimeAdapter,
        surfaceId: String,
        paneId: Int,
        direction: HistoryDirection
    ) async {
        guard let originalPane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        activateKeyboardPane(surfaceId: surfaceId, paneId: paneId)
        guard !originalPane.annotationMode else {
            originalPane.toast = "Finish annotation (Done) to navigate"
            return
        }
        let directionValue = direction == .back ? "back" : "forward"
        do {
            _ = try await commitLocalMutation(adapter: adapter, operation: "local.history.\(directionValue)") { state, sequence in
                guard state.liveSurfaces[surfaceId]?.panes[String(paneId)] != nil else {
                    throw SurfAceLocklessAuthorityError.invalidState("local_history_pane")
                }
                guard try SurfAceLocklessContentOperations.navigate(
                    state: &state,
                    surfaceId: surfaceId,
                    paneId: Int64(paneId),
                    direction: directionValue == "back" ? .back : .forward
                ) != nil else {
                    return .object(["commitSequence": .integer(sequence), "noop": .bool(true)])
                }
                return .object([
                    "commitSequence": .integer(sequence),
                    "direction": .string(directionValue),
                    "paneId": .integer(Int64(paneId)),
                    "surfaceId": .string(surfaceId),
                ])
            }
            let state = await adapter.snapshot()
            try projectLocklessAuthorityState(state)
            guard let projectedPane = self.pane(surfaceId: surfaceId, paneId: paneId) else { return }
            projectedPane.bridge?.render(entry: renderableEntry(projectedPane.currentEntry), restoreViewport: nil)
            restorePaneDrawing(surfaceId: surfaceId, pane: projectedPane)
            projectedPane.lastNavigationURL = projectedPane.currentEntry.url
            UIAccessibility.post(
                notification: .announcement,
                argument: projectedPane.currentCompositeProvenance().accessibilityLabel
            )
            await fanoutLocklessCommittedEvent(
                op: "event.history_navigated",
                payload: .object([
                    "direction": .string(directionValue),
                    "paneId": .integer(Int64(paneId)),
                    "revision": .integer(Int64(projectedPane.currentEntry.revision)),
                    "surfaceId": .string(surfaceId),
                ])
            )
            await drainControllerRetentionReclamations(adapter: adapter)
        } catch {
            originalPane.toast = "History navigation failed"
            endpointError = "Lockless history mutation failed: \(error.localizedDescription)"
        }
    }

    private func commitLocalAnnotationMode(
        adapter: SurfAceLocklessRuntimeAdapter,
        surfaceId: String,
        paneId: Int,
        enabled: Bool,
        fingerDrawEnabled: Bool,
        source: String?
    ) async {
        guard let originalPane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        let wasEnabled = originalPane.annotationMode
        do {
            _ = try await commitLocalMutation(adapter: adapter, operation: "local.annotation.mode") { state, sequence in
                guard var surface = state.liveSurfaces[surfaceId],
                      var authorityPane = surface.panes[String(paneId)] else {
                    throw SurfAceLocklessAuthorityError.invalidState("local_annotation_pane")
                }
                authorityPane.annotationMode = enabled
                surface.panes[String(paneId)] = authorityPane
                surface.surfaceRevision += 1
                state.liveSurfaces[surfaceId] = surface
                return .object([
                    "commitSequence": .integer(sequence),
                    "enabled": .bool(enabled),
                    "paneId": .integer(Int64(paneId)),
                    "surfaceId": .string(surfaceId),
                ])
            }
            try projectLocklessAuthorityState(await adapter.snapshot())
            guard let projectedPane = self.pane(surfaceId: surfaceId, paneId: paneId) else { return }
            activateKeyboardPane(surfaceId: surfaceId, paneId: paneId)
            projectedPane.fingerDrawEnabled = enabled && fingerDrawEnabled
            projectedPane.bridge?.setInteraction(
                annotationMode: projectedPane.annotationMode,
                fingerDrawEnabled: projectedPane.fingerDrawEnabled
            )
            let transitionSource = source ?? (enabled ? (fingerDrawEnabled ? "finger_button" : "annotation_button") : "done_button")
            surfAceLifecycleLog(
                "event=annotation_mode_changed \(surfAceDiagnosticFields([("surface_id", surfaceId), ("pane_id", paneId), ("enabled", projectedPane.annotationMode), ("finger_draw_enabled", projectedPane.fingerDrawEnabled), ("source", transitionSource)]))"
            )
            if wasEnabled && !enabled {
                requestAnnotationCommit(surfaceId: surfaceId, paneId: paneId)
                clearPaneDrawings(projectedPane)
            }
            await fanoutLocklessCommittedEvent(
                op: "event.annotation_mode_changed",
                payload: .object([
                    "enabled": .bool(enabled),
                    "paneId": .integer(Int64(paneId)),
                    "surfaceId": .string(surfaceId),
                ])
            )
            await drainControllerRetentionReclamations(adapter: adapter)
        } catch {
            originalPane.toast = "Annotation change failed"
            endpointError = "Lockless annotation mutation failed: \(error.localizedDescription)"
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

    func scaleActivePaneContent(_ action: SurfAceContentScaleAction) {
        scaleActivePaneContent(surfaceId: nil, action: action)
    }

    func scaleActivePaneContent(surfaceId: String?, action: SurfAceContentScaleAction) {
        let surface = if let surfaceId {
            surfaceById[surfaceId]
        } else {
            surfaces.first
        }
        guard let surface,
              let activePaneId = surface.activeKeyboardPaneId else {
            return
        }
        scalePaneContent(surfaceId: surface.surfaceId, paneId: activePaneId, action: action)
    }

    func scalePaneContent(surfaceId: String, paneId: Int, action: SurfAceContentScaleAction) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId),
              surfAcePaneContentCanScale(pane.currentEntry),
              !pane.annotationMode else {
            return
        }
        activateKeyboardPane(surfaceId: surfaceId, paneId: paneId)
        pane.contentScale = surfAceNextContentScale(pane.contentScale, action: action)
        pane.bridge?.setContentScale(pane.contentScale)
    }

    func browserGoBack(surfaceId: String, paneId: Int) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        activateKeyboardPane(surfaceId: surfaceId, paneId: paneId)
        guard !pane.annotationMode else {
            pane.toast = "Finish annotation (Done) to navigate"
            return
        }
        guard case .browserURL = pane.currentEntry.payload else { return }
        pane.bridge?.browserGoBack()
    }

    func browserGoForward(surfaceId: String, paneId: Int) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        activateKeyboardPane(surfaceId: surfaceId, paneId: paneId)
        guard !pane.annotationMode else {
            pane.toast = "Finish annotation (Done) to navigate"
            return
        }
        guard case .browserURL = pane.currentEntry.payload else { return }
        pane.bridge?.browserGoForward()
    }

    func handleBrowserNavigationStateChanged(surfaceId: String, paneId: Int, canGoBack: Bool, canGoForward: Bool) {
        guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
        guard case .browserURL = pane.currentEntry.payload else {
            if pane.canBrowserGoBack || pane.canBrowserGoForward {
                pane.canBrowserGoBack = false
                pane.canBrowserGoForward = false
            }
            return
        }
        pane.canBrowserGoBack = canGoBack
        pane.canBrowserGoForward = canGoForward
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
        if !surfAceEntryIsVisibleEmpty(previousEntry) {
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
        if let adapter = locklessAdapter,
           !legacyNegotiatedSurfaceIds.contains(surfaceId),
           !strokes.isEmpty {
            Task { @MainActor in
                await commitLocalStrokes(
                    adapter: adapter,
                    surfaceId: surfaceId,
                    paneId: paneId,
                    strokes: strokes,
                    drawingData: drawingData
                )
            }
            return
        }
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

    private func commitLocalStrokes(
        adapter: SurfAceLocklessRuntimeAdapter,
        surfaceId: String,
        paneId: Int,
        strokes: [SurfAceStroke],
        drawingData: Data
    ) async {
        do {
            let serializedStrokes = try Self.locklessJSON(
                Dictionary(uniqueKeysWithValues: strokes.map { ($0.strokeId, $0) })
            )
            _ = try await commitLocalMutation(adapter: adapter, operation: "local.annotation.stroke") { state, sequence in
                guard var surface = state.liveSurfaces[surfaceId],
                      var authorityPane = surface.panes[String(paneId)],
                      case .object(var annotations) = authorityPane.history.visible.annotations,
                      case .object(let incomingStrokes) = serializedStrokes else {
                    throw SurfAceLocklessAuthorityError.invalidState("local_annotation_material")
                }
                var storedStrokes: [String: SurfAceLocklessJSON]
                if case .object(let existingStrokes) = annotations["strokesById"] {
                    storedStrokes = existingStrokes
                } else {
                    storedStrokes = [:]
                }
                for (strokeId, stroke) in incomingStrokes {
                    storedStrokes[strokeId] = stroke
                }
                annotations["drawingData"] = .string(drawingData.base64EncodedString())
                annotations["strokesById"] = .object(storedStrokes)
                authorityPane.annotationMode = true
                authorityPane.history.visible.annotations = .object(annotations)
                surface.panes[String(paneId)] = authorityPane
                surface.surfaceRevision += 1
                state.liveSurfaces[surfaceId] = surface
                return .object([
                    "commitSequence": .integer(sequence),
                    "paneId": .integer(Int64(paneId)),
                    "strokeCount": .integer(Int64(strokes.count)),
                    "surfaceId": .string(surfaceId),
                ])
            }
            try projectLocklessAuthorityState(await adapter.snapshot())
            guard let pane = pane(surfaceId: surfaceId, paneId: paneId) else { return }
            pane.fingerDrawEnabled = false
            pane.bridge?.setInteraction(annotationMode: true, fingerDrawEnabled: false)
            for stroke in strokes {
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
            await drainControllerRetentionReclamations(adapter: adapter)
        } catch {
            endpointError = "Lockless annotation stroke mutation failed: \(error.localizedDescription)"
        }
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
                await self?.handleDidEnterBackground()
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

    func handleDidEnterBackground() async {
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
        await closeLocklessConnectionsForLifecycle(reason: "background")
    }

    private func closeLocklessConnectionsForLifecycle(reason: String) async {
        let connections = locklessConnectionsByConnectionUUID
        locklessConnectionsByConnectionUUID.removeAll()
        for connectionToken in connections.keys.sorted() {
            guard let connection = connections[connectionToken] else { continue }
            await connection.socket.close(code: 1000, reason: reason)
            try? await locklessAdapter?.disconnect(
                connectionToken: connectionToken,
                disconnectedAt: timestampNow()
            )
            if let locklessAdapter {
                await drainControllerRetentionReclamations(adapter: locklessAdapter)
            }
        }
    }

    private func handleWillEnterForeground() {
        surfAceLifecycleLog(
            "event=app_foreground \(surfAceDiagnosticFields([("pending_resumed_events", surfaceNeedsResumedEvent.count), ("surface_count", surfaces.count)]))"
        )
        if locklessAdapter != nil {
            Task { @MainActor in
                await restoreLocklessAuthority(reason: "foreground")
                publishBonjour()
                for surfaceId in surfaceNeedsResumedEvent {
                    refreshConnectionState(surfaceId: surfaceId)
                }
            }
            return
        }
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
                            "surface.window.open",
                            "surface.window.close",
                            "panes.list",
                            "pane.split",
                            "pane.rename",
                            "pane.close",
                            "diagnostics.flight_recorder",
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
        let sender = SurfAceOutboundSender(
            socket: socket,
            prepareSend: outboundSendPreparation
        )
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
                case .close(let code, let reason):
                    surfAceGatewayLog(
                        "event=socket_close_frame \(surfAceDiagnosticFields([("close_code", code), ("close_reason", reason ?? "nil"), ("connection_uuid", connectionUUID)]))"
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
                    if let postSendAction = processed.postSendAction,
                       !terminatedConnectionUUIDs.contains(connectionUUID) {
                        await postSendAction()
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
        if locklessConnectionsByConnectionUUID[connectionUUID] != nil {
            return await processLocklessRequest(
                op: op,
                id: id,
                payload: payload,
                connectionUUID: connectionUUID
            )
        }
        switch op {
        case "surfaces.list":
            return SurfAceProcessedRequestResult(
                responseObject: await handleSurfacesList(id: id), postSendPairCommit: nil
            )
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
        case "surface.window.open":
            return SurfAceProcessedRequestResult(
                responseObject: handleSurfaceWindowOpen(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        case "surface.window.close":
            return SurfAceProcessedRequestResult(
                responseObject: handleSurfaceWindowClose(id: id, payload: payload, connectionUUID: connectionUUID),
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
        case "diagnostics.flight_recorder":
            return SurfAceProcessedRequestResult(
                responseObject: handleFlightRecorderDiagnostics(id: id, payload: payload, connectionUUID: connectionUUID),
                postSendPairCommit: nil
            )
        default:
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(op: op, id: id, code: "invalid_payload", message: "unsupported operation"),
                postSendPairCommit: nil
            )
        }
    }

    private func handleSurfacesList(id: String) async -> [String: Any] {
        if let adapter = locklessAdapter {
            let readiness = await adapter.readinessSnapshot()
            if readiness.readyForAdmission {
                let state = readiness.state
                let limits = (try? Self.jsonObject(state.limits)) ?? [:]
                let tombstones = (try? state.surfaceTombstones.map(Self.jsonObject)) ?? []
                let liveControllerCount = state.controllers.values.filter { $0.status == .live }.count
                return [
                    "v": 1,
                    "type": "response",
                    "op": "surfaces.list",
                    "id": id,
                    "ok": true,
                    "sentAt": timestampNow(),
                    "payload": [
                        "admissionAvailable": Int64(liveControllerCount) < state.limits.maxAdmittedControllerEntries,
                        "capabilities": [
                            "limits": limits,
                            "protocolFeatures": SurfAceLocklessTargetAdmission.advertisedProtocolFeatures,
                            "surfaceLifecycle": true,
                        ],
                        "surfaceSetRevision": state.surfaceSetRevision,
                        "surfaceTombstones": tombstones,
                        "surfaces": state.liveSurfaces.values.sorted { $0.surfaceId < $1.surfaceId }.map { surface in
                            let runtimeSurface = surfaceById[surface.surfaceId]
                            return [
                                "surfaceId": surface.surfaceId,
                                "name": surface.name,
                                "viewport": runtimeSurface.map(viewportPayload(for:))
                                    ?? ["width": 1, "height": 1, "scale": 1],
                                "paired": false,
                            ] as [String: Any]
                        },
                    ],
                ]
            }
        }
        return [
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

    private func handleFlightRecorderDiagnostics(id: String, payload: [String: Any], connectionUUID: String) -> [String: Any] {
        guard let (surfaceId, _) = pairedSurface(for: connectionUUID) else {
            return makeErrorResponse(op: "diagnostics.flight_recorder", id: id, code: "not_paired", message: "pair.request required")
        }
        let requestedLines = payload["maxLines"] as? Int ?? 240
        let lineCount = min(max(requestedLines, 1), 512)
        let restoreAttemptId = payload["restoreAttemptId"] as? String
        surfAceLifecycleLog(
            "event=flight_recorder_requested \(surfAceDiagnosticFields([("line_count", lineCount), ("restore_attempt_id", restoreAttemptId), ("surface_id", surfaceId)]))"
        )
        return [
            "v": 1,
            "type": "response",
            "op": "diagnostics.flight_recorder",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "logPath": surfAceFlightRecorderLogPath(),
                "lines": surfAceFlightRecorderTail(maxLines: lineCount),
                "restoreAttemptId": restoreAttemptId as Any? ?? NSNull(),
                "surfaceId": surfaceId,
            ],
        ]
    }

    private func handleLocklessPairRequest(
        id: String,
        payload: [String: Any],
        socket: SurfAceWebSocket,
        sender: SurfAceOutboundSender,
        connectionUUID: String
    ) async -> SurfAceProcessedRequestResult {
        guard let controllerInstanceId = payload["controllerInstanceId"] as? String,
              let projectionCapacityBytes = Self.int64(payload["projectionCapacityBytes"]),
              let protocolFeatures = payload["protocolFeatures"] as? [String] else {
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(
                    op: "pair.request",
                    id: id,
                    code: "invalid_payload",
                    message: "lockless controllerInstanceId, projectionCapacityBytes, and protocolFeatures are required"
                ),
                postSendPairCommit: nil
            )
        }
        await beginLocklessAdmissionDeliveryBarrier(connectionUUID: connectionUUID)
        do {
            let adapter = try ensureLocklessAdapter()
            let readiness = await adapter.readinessSnapshot()
            guard readiness.readyForAdmission else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            let resume = try Self.locklessResumeState(from: payload["resume"])
            let surfaceId = payload["surfaceId"] as? String
            let admission = try await adapter.admit(
                controllerInstanceId: controllerInstanceId,
                controllerProductName: payload["controllerProductName"] as? String,
                connectionToken: connectionUUID,
                projectionCapacityBytes: projectionCapacityBytes,
                protocolFeatures: protocolFeatures,
                surfaceId: surfaceId,
                pendingAcks: resume.pendingAcks,
                unresolvedRequestIds: resume.unresolvedRequestIds
            )
            locklessConnectionsByConnectionUUID[connectionUUID] = (controllerInstanceId, sender, socket)
            let admittedState = await adapter.snapshot()
            applyNegotiatedModes(admittedState)
            let state = try Self.jsonObject(admittedState)
            let limits = try Self.jsonObject(admission.limits)
            let admittedScopeIds: [String]
            if let surfaceId, let surface = admittedState.liveSurfaces[surfaceId] {
                admittedScopeIds = [Self.locklessSurfaceScopeId(surfaceId)] + surface.panes.values
                    .sorted { $0.paneId < $1.paneId }
                    .map { Self.locklessPaneScopeId(surfaceId: surfaceId, paneId: $0.paneId) }
            } else {
                admittedScopeIds = []
            }
            let scopes = try await adapter.consumableSnapshots(
                connectionToken: connectionUUID, scopeIds: admittedScopeIds
            ).map(Self.jsonObject)
            return SurfAceProcessedRequestResult(
                responseObject: [
                    "v": 1,
                    "type": "response",
                    "op": "pair.request",
                    "id": id,
                    "ok": true,
                    "sentAt": timestampNow(),
                    "payload": [
                        "capabilities": [
                            "protocolFeatures": [surfAceLocklessCapability],
                            "limits": limits,
                            "surfaceLifecycle": true,
                        ],
                        "controllerInstanceId": controllerInstanceId,
                        "limits": limits,
                        "mode": "lockless",
                        "receiptResolutions": admission.receiptResolutions.map(Self.foundationJSON),
                        "resumed": admission.resumed,
                        "scopes": scopes,
                        "sessionId": connectionUUID,
                        "state": state,
                        "surfaceId": surfaceId as Any? ?? NSNull(),
                        "surfaceSetRevision": admittedState.surfaceSetRevision,
                    ],
                ],
                postSendPairCommit: nil,
                postSendAction: { [weak self, weak adapter] in
                    guard let self else { return }
                    defer { self.endLocklessAdmissionDeliveryBarrier(connectionUUID: connectionUUID) }
                    guard let adapter else { return }
                    await self.drainControllerRetentionReclamations(
                        adapter: adapter,
                        bypassingAdmissionBarrier: connectionUUID
                    )
                }
            )
        } catch let error as SurfAceLocklessRuntimeAdapterError {
            endLocklessAdmissionDeliveryBarrier(connectionUUID: connectionUUID)
            let code: String
            switch error {
            case .duplicateLiveController: code = "duplicate_controller_instance"
            case .controllerCapacity: code = "controller_capacity"
            case .capabilityMismatch: code = "capability_mismatch"
            default: code = "invalid_payload"
            }
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(op: "pair.request", id: id, code: code, message: String(describing: error)),
                postSendPairCommit: nil
            )
        } catch {
            endLocklessAdmissionDeliveryBarrier(connectionUUID: connectionUUID)
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(op: "pair.request", id: id, code: "client_state_unavailable", message: error.localizedDescription),
                postSendPairCommit: nil
            )
        }
    }

    private func processLocklessRequest(
        op: String,
        id: String,
        payload: [String: Any],
        connectionUUID: String
    ) async -> SurfAceProcessedRequestResult {
        guard let adapter = locklessAdapter else {
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(op: op, id: id, code: "not_paired", message: "pair.request required"),
                postSendPairCommit: nil
            )
        }
        do {
            if let surfaceId = payload["surfaceId"] as? String {
                let authority = await adapter.snapshot()
                if authority.negotiatedModes[surfaceId] != .lockless {
                    return SurfAceProcessedRequestResult(
                        responseObject: makeErrorResponse(
                            op: op, id: id, code: "capability_mismatch",
                            message: "surface is not negotiated in lockless mode"
                        ),
                        postSendPairCommit: nil
                    )
                }
            } else if op == "surface.window.restore",
                      let tombstoneId = payload["tombstoneId"] as? String {
                let authority = await adapter.snapshot()
                let retainedSurfaceId = authority.surfaceTombstones.first(where: {
                    $0.tombstoneId == tombstoneId
                })?.surface.surfaceId
                if retainedSurfaceId.flatMap({ authority.negotiatedModes[$0] }) != .lockless {
                    return SurfAceProcessedRequestResult(
                        responseObject: makeErrorResponse(
                            op: op, id: id, code: "capability_mismatch",
                            message: "retained surface is not negotiated in lockless mode"
                        ),
                        postSendPairCommit: nil
                    )
                }
            }
            let responsePayload: Any
            switch op {
            case "surfaces.list":
                let snapshot = await adapter.snapshot()
                responsePayload = [
                    "surfaceSetRevision": snapshot.surfaceSetRevision,
                    "surfaces": try snapshot.liveSurfaces.values.sorted { $0.surfaceId < $1.surfaceId }.map(Self.jsonObject),
                ]
            case "panes.list":
                let snapshot = await adapter.snapshot()
                guard let surfaceId = payload["surfaceId"] as? String,
                      let surface = snapshot.liveSurfaces[surfaceId] else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                responsePayload = [
                    "panes": try surface.panes.values.sorted { $0.paneId < $1.paneId }.map(Self.jsonObject),
                    "surfaceId": surfaceId,
                    "topologyRevision": surface.topologyRevision,
                ]
            case "operation.receipt.sync":
                guard let requestIds = payload["requestIds"] as? [String] else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                responsePayload = [
                    "resolutions": try await adapter.resolveReceipts(
                        connectionToken: connectionUUID,
                        requestIds: requestIds
                    ).map(Self.foundationJSON),
                ]
            case "operation.receipt.ack":
                guard let requestId = payload["requestId"] as? String else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                try await adapter.acknowledgeReceipts(connectionToken: connectionUUID, requestIds: [requestId])
                responsePayload = ["accepted": true, "requestId": requestId]
            case "consumable.sync":
                guard let scopeIds = payload["scopeIds"] as? [String] else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                responsePayload = [
                    "snapshots": try await adapter.consumableSnapshots(
                        connectionToken: connectionUUID, scopeIds: scopeIds
                    ).map(Self.jsonObject),
                ]
            case "consumable.ack":
                guard let scopeId = payload["scopeId"] as? String,
                      let cursor = Self.int64(payload["cursor"]) else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                try await adapter.acknowledgeConsumable(
                    connectionToken: connectionUUID,
                    scopeId: scopeId,
                    cursor: cursor,
                    gapGeneration: Self.int64(payload["gapGeneration"])
                )
                responsePayload = ["acceptedCursor": cursor, "scopeId": scopeId]
            case "annotations.remove":
                return await handleLocklessAnnotationsRemove(
                    id: id,
                    payload: payload,
                    connectionUUID: connectionUUID,
                    adapter: adapter
                )
            case "snapshot.get":
                return await handleLocklessSnapshotGet(id: id, payload: payload, adapter: adapter)
            case "target.apply":
                return await handleLocklessTargetApply(
                    id: id, payload: payload, connectionUUID: connectionUUID, adapter: adapter
                )
            case "content.set", "content.append", "content.patch", "content.clear":
                return await handleLocklessContentMutation(
                    op: op, id: id, payload: payload,
                    connectionUUID: connectionUUID, adapter: adapter
                )
            case "pane.split", "pane.rename", "pane.close", "pane.restore", "topology.apply",
                 "surface.window.open", "surface.window.close", "surface.window.restore":
                return await handleLocklessTopologyMutation(
                    op: op,
                    id: id,
                    payload: payload,
                    connectionUUID: connectionUUID,
                    adapter: adapter
                )
            case "heartbeat.ping":
                guard let nonce = payload["nonce"] as? String, !nonce.isEmpty else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                responsePayload = ["nonce": nonce]
            default:
                return SurfAceProcessedRequestResult(
                    responseObject: makeErrorResponse(
                        op: op,
                        id: id,
                        code: "unsupported_operation",
                        message: "native lockless operation is not yet routed through client authority"
                    ),
                    postSendPairCommit: nil
                )
            }
            return SurfAceProcessedRequestResult(
                responseObject: [
                    "v": 1,
                    "type": "response",
                    "op": op,
                    "id": id,
                    "ok": true,
                    "sentAt": timestampNow(),
                    "payload": responsePayload,
                ],
                postSendPairCommit: nil
            )
        } catch let error as SurfAceLocklessRuntimeAdapterError {
            return locklessAdapterErrorResult(op: op, id: id, error: error)
        } catch {
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(op: op, id: id, code: "invalid_payload", message: String(describing: error)),
                postSendPairCommit: nil
            )
        }
    }

    private func handleLocklessAnnotationsRemove(
        id: String,
        payload: [String: Any],
        connectionUUID: String,
        adapter: SurfAceLocklessRuntimeAdapter
    ) async -> SurfAceProcessedRequestResult {
        do {
            guard let surfaceId = payload["surfaceId"] as? String,
                  let paneId = Self.int64(payload["paneId"]),
                  let contentId = payload["contentId"] as? String,
                  let requestedStrokeIds = payload["strokeIds"] as? [String],
                  let authorityPane = (await adapter.snapshot()).liveSurfaces[surfaceId]?.panes[String(paneId)],
                  authorityPane.history.visible.contentId == contentId else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            let expectedHistoryEntryId = authorityPane.history.visible.historyEntryId
            let expectedRevision = authorityPane.history.visible.revision
            guard case .object(let annotations) = authorityPane.history.visible.annotations,
                  case .string(let drawingDataBase64) = annotations["drawingData"],
                  let drawingData = Data(base64Encoded: drawingDataBase64),
                  let strokesJSON = annotations["strokesById"] else {
                throw SurfAceLocklessAuthorityError.invalidState("annotation_material")
            }
            let strokesById = try JSONDecoder().decode(
                [String: SurfAceStroke].self,
                from: JSONEncoder().encode(strokesJSON)
            )
            let transformed = try surfAceRemovingAnnotationStrokes(
                drawingData: drawingData,
                strokesById: strokesById,
                requestedStrokeIds: requestedStrokeIds
            )
            let nextStrokesJSON = try JSONDecoder().decode(
                SurfAceLocklessJSON.self,
                from: JSONEncoder().encode(transformed.strokesById)
            )
            let nextAnnotations: SurfAceLocklessJSON = .object([
                "drawingData": .string(transformed.drawingData.base64EncodedString()),
                "strokesById": nextStrokesJSON,
            ])
            let removedStrokeIds = transformed.removedStrokeIds
            let notFoundStrokeIds = transformed.notFoundStrokeIds
            let remainingStrokeCount = transformed.strokesById.count
            let committed = try await adapter.commitMutation(
                connectionToken: connectionUUID,
                requestId: id,
                operation: "annotations.remove",
                consumableScopeId: Self.locklessPaneScopeId(surfaceId: surfaceId, paneId: paneId),
                consumableScopeKind: "pane",
                consumableRecordClass: .annotationFrame
            ) { state, sequence in
                guard var surface = state.liveSurfaces[surfaceId],
                      var pane = surface.panes[String(paneId)],
                      pane.history.visible.historyEntryId == expectedHistoryEntryId,
                      pane.history.visible.revision == expectedRevision else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                pane.history.visible.annotations = nextAnnotations
                surface.panes[String(paneId)] = pane
                surface.surfaceRevision += 1
                state.liveSurfaces[surfaceId] = surface
                return .object([
                    "contentId": .string(contentId),
                    "operationReceipt": .object([
                        "commitSequence": .integer(sequence),
                        "requestId": .string(id),
                    ]),
                    "paneId": .integer(paneId),
                    "remainingStrokeCount": .integer(Int64(remainingStrokeCount)),
                    "removedStrokeIds": .array(removedStrokeIds.map(SurfAceLocklessJSON.string)),
                    "notFoundStrokeIds": .array(notFoundStrokeIds.map(SurfAceLocklessJSON.string)),
                    "surfaceId": .string(surfaceId),
                ])
            }
            if let failure = locklessCommittedFailureResult(committed, adapter: adapter) { return failure }
            try projectLocklessAuthorityState(await adapter.snapshot())
            await fanoutLocklessConsumable(
                scopeId: Self.locklessPaneScopeId(surfaceId: surfaceId, paneId: paneId),
                adapter: adapter
            )
            await fanoutLocklessCommittedEvent(
                op: "event.lockless_content_committed",
                payload: .object([
                    "contentId": .string(contentId),
                    "historyEntryId": .string(expectedHistoryEntryId),
                    "paneId": .integer(paneId),
                    "revision": .integer(expectedRevision),
                    "surfaceId": .string(surfaceId),
                ])
            )
            return try locklessCommittedResponseResult(committed, adapter: adapter)
        } catch let error as SurfAceLocklessRuntimeAdapterError {
            return await commitLocklessFailure(
                op: "annotations.remove", id: id, code: "invalid_payload",
                message: String(describing: error), error: error,
                connectionUUID: connectionUUID, adapter: adapter
            )
        } catch {
            return await commitLocklessFailure(
                op: "annotations.remove", id: id, code: "invalid_payload",
                message: String(describing: error), error: error,
                connectionUUID: connectionUUID, adapter: adapter
            )
        }
    }

    private func handleLocklessContentMutation(
        op: String,
        id: String,
        payload: [String: Any],
        connectionUUID: String,
        adapter: SurfAceLocklessRuntimeAdapter
    ) async -> SurfAceProcessedRequestResult {
        do {
            guard let surfaceId = payload["surfaceId"] as? String,
                  let paneId = Self.int64(payload["paneId"]) else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            let authorityBefore = await adapter.snapshot()
            let controllerProductName = locklessConnectionsByConnectionUUID[connectionUUID].flatMap {
                authorityBefore.controllers[$0.controllerInstanceId]?.controllerProductName
            }
            let committed: SurfAceLocklessCommittedMutation
            switch op {
            case "content.set":
                guard let contentId = payload["contentId"] as? String,
                      let contentType = payload["contentType"] as? String,
                      let contentValue = payload["content"] else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                let content = try Self.locklessJSON(fromFoundation: contentValue)
                let friendlyChatName = payload["friendlyChatName"] as? String
                let intent = SurfAceLocklessContentSetIntent(
                    content: content,
                    contentId: contentId,
                    contentType: contentType,
                    controllerProductName: controllerProductName,
                    friendlyChatName: friendlyChatName,
                    paneId: paneId,
                    surfaceId: surfaceId
                )
                committed = try await adapter.commitMutation(
                    connectionToken: connectionUUID, requestId: id, operation: op,
                    consumableScopeId: Self.locklessPaneScopeId(surfaceId: surfaceId, paneId: paneId),
                    consumableScopeKind: "pane", consumableRecordClass: .content,
                    consumablePayload: Self.locklessContentConsumablePayload(surfaceId: surfaceId, paneId: paneId)
                ) { state, sequence in
                    let result = try SurfAceLocklessContentOperations.set(state: &state, intent: intent)
                    return Self.locklessContentResultJSON(result, requestId: id, sequence: sequence)
                }
            case "content.append":
                guard let contentId = payload["contentId"] as? String,
                      let expected = Self.int64(payload["expectedRevision"]),
                      let lines = payload["lines"] as? [String] else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                committed = try await adapter.commitMutation(
                    connectionToken: connectionUUID, requestId: id, operation: op,
                    consumableScopeId: Self.locklessPaneScopeId(surfaceId: surfaceId, paneId: paneId),
                    consumableScopeKind: "pane", consumableRecordClass: .content,
                    consumablePayload: Self.locklessContentConsumablePayload(surfaceId: surfaceId, paneId: paneId)
                ) { state, sequence in
                    let result = try SurfAceLocklessContentOperations.append(
                        state: &state, surfaceId: surfaceId, paneId: paneId,
                        contentId: contentId, expectedRevision: expected, lines: lines
                    )
                    return Self.locklessContentResultJSON(result, requestId: id, sequence: sequence)
                }
            case "content.clear":
                guard let expected = Self.int64(payload["expectedRevision"]) else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                committed = try await adapter.commitMutation(
                    connectionToken: connectionUUID, requestId: id, operation: op,
                    consumableScopeId: Self.locklessPaneScopeId(surfaceId: surfaceId, paneId: paneId),
                    consumableScopeKind: "pane", consumableRecordClass: .content,
                    consumablePayload: Self.locklessContentConsumablePayload(surfaceId: surfaceId, paneId: paneId)
                ) { state, sequence in
                    let result = try SurfAceLocklessContentOperations.clear(
                        state: &state, surfaceId: surfaceId, paneId: paneId,
                        expectedRevision: expected
                    )
                    return Self.locklessContentResultJSON(result, requestId: id, sequence: sequence)
                }
            case "content.patch":
                guard let contentId = payload["contentId"] as? String,
                      let expected = Self.int64(payload["expectedRevision"]),
                      let patch = payload["patch"] as? [String: Any],
                      let selector = patch["selector"] as? String,
                      let action = patch["action"] as? String else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                let preparation = try SurfAceLocklessContentOperations.preparePatch(
                    state: await adapter.snapshot(), surfaceId: surfaceId, paneId: paneId,
                    contentId: contentId, expectedRevision: expected
                )
                guard let localPaneId = Int(exactly: paneId),
                      let bridge = pane(surfaceId: surfaceId, paneId: localPaneId)?.bridge else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                let patchRequest = SurfAceFramePatchRequest(
                    contentId: contentId,
                    selector: selector,
                    action: action,
                    html: patch["html"] as? String
                )
                let updatedHTML: String
                switch await bridge.applyHTMLPatch(patchRequest) {
                case .success(let html): updatedHTML = html
                case .selectorNotFound, .invalidAction, .failed(_):
                    throw SurfAceLocklessContentOperationError.invalidContent("html_patch_failed")
                }
                guard case .object(var patchedContent) = preparation.sourceContent else {
                    throw SurfAceLocklessContentOperationError.invalidContent("html_content")
                }
                patchedContent["html"] = .string(updatedHTML)
                let patchedContentJSON = SurfAceLocklessJSON.object(patchedContent)
                do {
                    committed = try await adapter.commitMutation(
                        connectionToken: connectionUUID, requestId: id, operation: op,
                        consumableScopeId: Self.locklessPaneScopeId(surfaceId: surfaceId, paneId: paneId),
                        consumableScopeKind: "pane", consumableRecordClass: .content,
                        consumablePayload: Self.locklessContentConsumablePayload(surfaceId: surfaceId, paneId: paneId)
                    ) { state, sequence in
                        let result = try SurfAceLocklessContentOperations.commitPatch(
                            state: &state,
                            preparation: preparation,
                            patchedContent: patchedContentJSON
                        )
                        return Self.locklessContentResultJSON(result, requestId: id, sequence: sequence)
                    }
                } catch {
                    try? projectLocklessAuthorityState(await adapter.snapshot())
                    throw error
                }
            default:
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            if let failure = locklessCommittedFailureResult(committed, adapter: adapter) { return failure }
            try projectLocklessAuthorityState(await adapter.snapshot())
            await fanoutLocklessConsumable(
                scopeId: Self.locklessPaneScopeId(surfaceId: surfaceId, paneId: paneId),
                adapter: adapter
            )
            if case .object(let terminal) = committed.responsePayload,
               case .string(let contentId) = terminal["contentId"],
               case .string(let historyEntryId) = terminal["historyEntryId"],
               case .integer(let revision) = terminal["revision"] {
                await fanoutLocklessCommittedEvent(
                    op: "event.lockless_content_committed",
                    payload: .object([
                        "contentId": .string(contentId),
                        "historyEntryId": .string(historyEntryId),
                        "paneId": .integer(paneId),
                        "revision": .integer(revision),
                        "surfaceId": .string(surfaceId),
                    ])
                )
            }
            return try locklessCommittedResponseResult(committed, adapter: adapter)
        } catch let error as SurfAceLocklessContentOperationError {
            let code: String
            switch error {
            case .staleContent: code = "stale_content"
            case .paneStateCapacity: code = "pane_state_capacity"
            default: code = "invalid_payload"
            }
            return await commitLocklessFailure(
                op: op, id: id, code: code, message: String(describing: error),
                error: error, connectionUUID: connectionUUID, adapter: adapter
            )
        } catch let error as SurfAceLocklessRuntimeAdapterError {
            return await commitLocklessFailure(
                op: op, id: id, code: "invalid_payload", message: String(describing: error),
                error: error, connectionUUID: connectionUUID, adapter: adapter
            )
        } catch {
            return await commitLocklessFailure(
                op: op, id: id, code: "invalid_payload", message: String(describing: error),
                error: error, connectionUUID: connectionUUID, adapter: adapter
            )
        }
    }

    nonisolated private static func locklessContentResultJSON(
        _ result: SurfAceLocklessContentMutationResult,
        requestId: String,
        sequence: Int64
    ) -> SurfAceLocklessJSON {
        .object([
            "contentId": result.contentId.map(SurfAceLocklessJSON.string) ?? .null,
            "contentType": result.contentType.map(SurfAceLocklessJSON.string) ?? .null,
            "historyEntryId": result.historyEntryId.map(SurfAceLocklessJSON.string) ?? .null,
            "operationReceipt": locklessReceiptJSON(requestId: requestId, sequence: sequence),
            "paneId": .integer(result.paneId),
            "revision": .integer(result.currentRevision),
        ])
    }

    nonisolated private static func locklessContentConsumablePayload(
        surfaceId: String,
        paneId: Int64
    ) -> SurfAceLocklessRuntimeAdapter.ConsumablePayload {
        { state, _ in
            guard let entry = state.liveSurfaces[surfaceId]?.panes[String(paneId)]?.history.visible else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            return .object([
                "annotations": try locklessJSON(entry.annotations),
                "content": entry.content,
                "contentId": entry.contentId.map(SurfAceLocklessJSON.string) ?? .null,
                "contentType": entry.contentType.map(SurfAceLocklessJSON.string) ?? .null,
                "historyEntryId": .string(entry.historyEntryId),
                "paneId": .integer(paneId),
                "provenance": try locklessJSON(entry.provenance),
                "revision": .integer(entry.revision),
                "surfaceId": .string(surfaceId),
            ])
        }
    }

    private func handleLocklessSnapshotGet(
        id: String,
        payload: [String: Any],
        adapter: SurfAceLocklessRuntimeAdapter
    ) async -> SurfAceProcessedRequestResult {
        guard let surfaceId = payload["surfaceId"] as? String,
              let paneId64 = Self.int64(payload["paneId"]),
              let paneId = Int(exactly: paneId64) else {
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(
                    op: "snapshot.get", id: id, code: "invalid_payload",
                    message: "surfaceId and paneId are required"
                ),
                postSendPairCommit: nil
            )
        }
        let authority = await adapter.snapshot()
        guard let authorityPane = authority.liveSurfaces[surfaceId]?.panes[String(paneId64)],
              let pane = pane(surfaceId: surfaceId, paneId: paneId) else {
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(
                    op: "snapshot.get", id: id, code: "invalid_payload",
                    message: "surface or pane is unavailable"
                ),
                postSendPairCommit: nil
            )
        }
        let includeImage = payload["includeImage"] as? Bool ?? false
        let includeVisibleText = payload["includeVisibleText"] as? Bool ?? true
        let includeDrawings = payload["includeDrawings"] as? Bool ?? false
        let snapshot = await pane.bridge?.fetchSnapshot(includeImage: includeImage)
        pane.lastViewport = snapshot?.viewport ?? defaultViewport(surface: surfaceById[surfaceId])
        if let visibleText = snapshot?.visibleText { pane.lastVisibleText = visibleText }
        pane.lastSelection = snapshot?.selection ?? pane.lastSelection

        var responsePayload: [String: Any] = [
            "paneId": paneId,
            "contentId": jsonValue(authorityPane.history.visible.contentId),
            "revision": authorityPane.history.visible.revision,
            "contentType": jsonValue(authorityPane.history.visible.contentType),
            "viewport": jsonObject(fromEncodable: pane.lastViewport) ?? NSNull(),
            "selection": jsonObject(fromEncodable: pane.lastSelection) ?? NSNull(),
        ]
        if includeVisibleText {
            responsePayload["visibleText"] = pane.lastVisibleText.prefix(maxVisibleTextBytes).description
        }
        if includeDrawings,
           case .object(let annotations) = authorityPane.history.visible.annotations,
           case .object(let strokes) = annotations["strokesById"] {
            responsePayload["drawings"] = strokes.keys.sorted().compactMap { key in
                strokes[key].map(Self.foundationJSON)
            }
        }
        if includeImage, let image = snapshot?.imageBase64 { responsePayload["image"] = image }
        return SurfAceProcessedRequestResult(
            responseObject: [
                "v": 1, "type": "response", "op": "snapshot.get", "id": id,
                "ok": true, "sentAt": timestampNow(), "payload": responsePayload,
            ],
            postSendPairCommit: nil
        )
    }

    private func handleLocklessTargetApply(
        id: String,
        payload: [String: Any],
        connectionUUID: String,
        adapter: SurfAceLocklessRuntimeAdapter
    ) async -> SurfAceProcessedRequestResult {
        do {
            guard let targetRequestId = payload["requestId"] as? String,
                  let surfaceId = payload["surfaceId"] as? String,
                  let targetId = payload["targetId"] as? String,
                  let targetEpoch = Self.int64(payload["targetEpoch"]),
                  payload["targetKind"] is String,
                  payload["targetHeader"] is [String: Any],
                  payload["targetPayload"] != nil else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            let request = try Self.locklessJSON(fromFoundation: payload)
            let committed = try await adapter.commitTargetIntent(
                connectionToken: connectionUUID,
                operationRequestId: id,
                targetRequestId: targetRequestId,
                surfaceId: surfaceId,
                targetId: targetId,
                targetEpoch: targetEpoch,
                request: request
            )
            guard let targetOperationIdentity = committed.targetOperationIdentity else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            if let failure = locklessCommittedFailureResult(committed, adapter: adapter) { return failure }
            return try locklessCommittedResponseResult(
                committed,
                adapter: adapter,
                postSendAction: { [weak self, weak adapter] in
                    guard let self, let adapter else { return }
                    await self.drainControllerRetentionReclamations(adapter: adapter)
                    do {
                        let result = try await adapter.materializeTargetWork(
                            identity: targetOperationIdentity
                        ) { work in
                            await self.materializeLocklessTargetWork(work)
                        }
                        try self.projectLocklessAuthorityState(await adapter.snapshot())
                        await self.fanoutLocklessTargetResult(result)
                        await self.fanoutLocklessConsumable(
                            scopeId: Self.locklessSurfaceScopeId(result.surfaceId), adapter: adapter
                        )
                    } catch {
                        self.endpointError = "Lockless target materialization failed: \(error.localizedDescription)"
                    }
                }
            )
        } catch let error as SurfAceLocklessRuntimeAdapterError {
            return locklessAdapterErrorResult(op: "target.apply", id: id, error: error)
        } catch {
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(
                    op: "target.apply",
                    id: id,
                    code: "invalid_payload",
                    message: String(describing: error)
                ),
                postSendPairCommit: nil
            )
        }
    }

    private func materializeLocklessTargetWork(
        _ work: SurfAceLocklessTargetWorkItem
    ) async -> SurfAceLocklessMaterializationOutcome {
        guard let payload = Self.foundationJSON(work.request) as? [String: Any] else {
            return SurfAceLocklessMaterializationOutcome(
                errorCode: "invalid_payload", materializedState: nil, status: "failed"
            )
        }
        let response = await materializeTargetApply(
            id: work.operationRequestId, payload: payload, surfaceId: work.surfaceId
        )
        guard let result = response["payload"] as? [String: Any],
              let status = result["status"] as? String else {
            return SurfAceLocklessMaterializationOutcome(
                errorCode: "materialization_failed", materializedState: nil, status: "failed"
            )
        }
        let materializedState = try? result["materializedState"].map(Self.locklessJSON(fromFoundation:))
        return SurfAceLocklessMaterializationOutcome(
            errorCode: result["errorCode"] as? String,
            materializedState: materializedState ?? nil,
            status: status == "applied" ? "applied" : "failed"
        )
    }

    private func fanoutLocklessTargetResult(_ result: SurfAceLocklessTargetResult) async {
        var event: [String: SurfAceLocklessJSON] = [
            "consumableSequence": .integer(result.consumableSequence),
            "intentCommitSequence": .integer(result.intentCommitSequence),
            "operationRequestId": .string(result.operationRequestId),
            "recordId": .string(result.recordId),
            "status": .string(result.status),
            "surfaceId": .string(result.surfaceId),
            "targetEpoch": .integer(result.targetEpoch),
            "targetId": .string(result.targetId),
            "targetRequestId": .string(result.targetRequestId),
        ]
        event["errorCode"] = result.errorCode.map(SurfAceLocklessJSON.string)
        event["materializedState"] = result.materializedState
        await fanoutLocklessCommittedEvent(op: "event.target_apply_result", payload: .object(event))
    }

    private func handleLocklessTopologyMutation(
        op: String,
        id: String,
        payload: [String: Any],
        connectionUUID: String,
        adapter: SurfAceLocklessRuntimeAdapter
    ) async -> SurfAceProcessedRequestResult {
        do {
            let committed: SurfAceLocklessCommittedMutation
            switch op {
            case "pane.split":
                guard let surfaceId = payload["surfaceId"] as? String,
                      let paneId = Self.int64(payload["paneId"]),
                      let count = Self.int64(payload["count"]),
                      let direction = payload["direction"] as? String,
                      let expected = Self.int64(payload["expectedTopologyRevision"]) else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                committed = try await adapter.commitMutation(
                    connectionToken: connectionUUID, requestId: id, operation: op,
                    consumableScopeId: Self.locklessSurfaceScopeId(surfaceId),
                    consumableScopeKind: "surface", consumableRecordClass: .topology
                ) { state, sequence in
                    let result = try SurfAceLocklessTopologyOperations.paneSplit(
                        state: &state, surfaceId: surfaceId, paneId: paneId, count: count,
                        direction: direction, expectedTopologyRevision: expected
                    )
                    return .object([
                        "newPaneIds": .array(result.newPaneIds.map(SurfAceLocklessJSON.integer)),
                        "newPaneLabels": .array(result.newPaneLabels.map(SurfAceLocklessJSON.integer)),
                        "operationReceipt": Self.locklessReceiptJSON(requestId: id, sequence: sequence),
                        "topology": result.topology,
                        "topologyRevision": .integer(result.topologyRevision),
                    ])
                }
            case "pane.rename":
                guard let surfaceId = payload["surfaceId"] as? String,
                      let paneId = Self.int64(payload["paneId"]),
                      let expected = Self.int64(payload["expectedTopologyRevision"]),
                      payload.keys.contains("name") else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                let name = payload["name"] as? String
                committed = try await adapter.commitMutation(
                    connectionToken: connectionUUID, requestId: id, operation: op,
                    consumableScopeId: Self.locklessSurfaceScopeId(surfaceId),
                    consumableScopeKind: "surface", consumableRecordClass: .topology
                ) { state, sequence in
                    let result = try SurfAceLocklessTopologyOperations.paneRename(
                        state: &state, surfaceId: surfaceId, paneId: paneId, name: name,
                        expectedTopologyRevision: expected
                    )
                    return .object([
                        "name": result.name.map(SurfAceLocklessJSON.string) ?? .null,
                        "operationReceipt": Self.locklessReceiptJSON(requestId: id, sequence: sequence),
                        "paneId": .integer(result.paneId),
                        "topologyRevision": .integer(result.topologyRevision),
                    ])
                }
            case "pane.close":
                guard let surfaceId = payload["surfaceId"] as? String,
                      let paneId = Self.int64(payload["paneId"]),
                      let expected = Self.int64(payload["expectedTopologyRevision"]) else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                committed = try await adapter.commitMutation(
                    connectionToken: connectionUUID, requestId: id, operation: op,
                    consumableScopeId: Self.locklessSurfaceScopeId(surfaceId),
                    consumableScopeKind: "surface", consumableRecordClass: .topology
                ) { state, sequence in
                    let result = try SurfAceLocklessTopologyOperations.paneClose(
                        state: &state, surfaceId: surfaceId, paneId: paneId,
                        expectedTopologyRevision: expected
                    )
                    return .object([
                        "closedSequence": .integer(result.closedSequence),
                        "operationReceipt": Self.locklessReceiptJSON(requestId: id, sequence: sequence),
                        "paneId": .integer(result.paneId),
                        "tombstoneId": .string(result.tombstoneId),
                        "topology": result.topology,
                        "topologyRevision": .integer(result.topologyRevision),
                    ])
                }
            case "pane.restore":
                guard let surfaceId = payload["surfaceId"] as? String,
                      let tombstoneId = payload["tombstoneId"] as? String,
                      let anchorPaneId = Self.int64(payload["anchorPaneId"]),
                      let direction = payload["direction"] as? String,
                      let expected = Self.int64(payload["expectedTopologyRevision"]) else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                committed = try await adapter.commitMutation(
                    connectionToken: connectionUUID, requestId: id, operation: op,
                    consumableScopeId: Self.locklessSurfaceScopeId(surfaceId),
                    consumableScopeKind: "surface", consumableRecordClass: .topology
                ) { state, sequence in
                    let result = try SurfAceLocklessTopologyOperations.paneRestore(
                        state: &state, surfaceId: surfaceId, tombstoneId: tombstoneId,
                        anchorPaneId: anchorPaneId, direction: direction,
                        expectedTopologyRevision: expected
                    )
                    return .object([
                        "operationReceipt": Self.locklessReceiptJSON(requestId: id, sequence: sequence),
                        "paneId": .integer(result.paneId),
                        "paneLabel": .integer(result.paneLabel),
                        "tombstoneId": .string(result.tombstoneId),
                        "topology": result.topology,
                        "topologyRevision": .integer(result.topologyRevision),
                    ])
                }
            case "topology.apply":
                guard let surfaceId = payload["surfaceId"] as? String,
                      let expected = Self.int64(payload["expectedTopologyRevision"]),
                      let allowDestroy = payload["allowDestroyPaneIds"] as? [Any],
                      let desiredValue = payload["desired"],
                      let target = payload["target"] as? [String: Any] else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                let allowDestroyPaneIds = try allowDestroy.map {
                    guard let value = Self.int64($0) else { throw SurfAceLocklessRuntimeAdapterError.invalidAdmission }
                    return value
                }
                let desired = try Self.locklessJSON(fromFoundation: desiredValue)
                let targetPaneId = Self.int64(target["paneId"])
                guard targetPaneId != nil || target["root"] as? Bool == true else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                committed = try await adapter.commitMutation(
                    connectionToken: connectionUUID, requestId: id, operation: op,
                    consumableScopeId: Self.locklessSurfaceScopeId(surfaceId),
                    consumableScopeKind: "surface", consumableRecordClass: .topology
                ) { state, sequence in
                    let result = try SurfAceLocklessTopologyOperations.topologyApply(
                        state: &state, surfaceId: surfaceId, targetPaneId: targetPaneId,
                        desired: desired, allowDestroyPaneIds: allowDestroyPaneIds,
                        expectedTopologyRevision: expected
                    )
                    return .object([
                        "createdPaneIds": .array(result.createdPaneIds.map(SurfAceLocklessJSON.integer)),
                        "destroyedPaneIds": .array(result.destroyedPaneIds.map(SurfAceLocklessJSON.integer)),
                        "destroyedPaneTombstones": .array(result.destroyedPaneTombstones.map { tombstone in
                            .object([
                                "closedSequence": .integer(tombstone.closedSequence),
                                "paneId": .integer(tombstone.paneId),
                                "tombstoneId": .string(tombstone.tombstoneId),
                            ])
                        }),
                        "operationReceipt": Self.locklessReceiptJSON(requestId: id, sequence: sequence),
                        "panes": try Self.locklessJSON(result.panes),
                        "preservedPaneIds": .array(result.preservedPaneIds.map(SurfAceLocklessJSON.integer)),
                        "topology": result.topology,
                        "topologyRevision": .integer(result.topologyRevision),
                    ])
                }
            case "surface.window.open":
                guard let expected = Self.int64(payload["expectedSurfaceSetRevision"]) else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                let placement = try payload["placement"].map(Self.locklessJSON(fromFoundation:))
                committed = try await adapter.commitMutation(
                    connectionToken: connectionUUID, requestId: id, operation: op
                ) { state, sequence in
                    let result = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
                        state: &state, expectedSurfaceSetRevision: expected, placement: placement
                    )
                    state.negotiatedModes[result.surface.surfaceId] = .lockless
                    let terminal: SurfAceLocklessJSON = .object([
                        "operationReceipt": Self.locklessReceiptJSON(requestId: id, sequence: sequence),
                        "surface": try Self.locklessJSON(result.surface),
                        "surfaceSetRevision": .integer(result.surfaceSetRevision),
                    ])
                    _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
                        in: &state,
                        scopeId: Self.locklessSurfaceScopeId(result.surface.surfaceId),
                        scopeKind: "surface",
                        recordId: "record:\(sequence)",
                        recordClass: .topology,
                        payload: terminal
                    )
                    return terminal
                }
            case "surface.window.close":
                guard let surfaceId = payload["surfaceId"] as? String,
                      let surfaceSet = Self.int64(payload["expectedSurfaceSetRevision"]),
                      let topology = Self.int64(payload["expectedTopologyRevision"]) else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                committed = try await adapter.commitMutation(
                    connectionToken: connectionUUID, requestId: id, operation: op
                ) { state, sequence in
                    _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
                        in: &state,
                        scopeId: Self.locklessSurfaceScopeId(surfaceId),
                        scopeKind: "surface",
                        recordId: "record:\(sequence)",
                        recordClass: .topology,
                        payload: .object([
                            "operation": .string(op),
                            "surfaceId": .string(surfaceId),
                        ])
                    )
                    let result = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
                        state: &state, surfaceId: surfaceId,
                        expectedSurfaceSetRevision: surfaceSet, expectedTopologyRevision: topology
                    )
                    return .object([
                        "closedSequence": .integer(result.closedSequence),
                        "operationReceipt": Self.locklessReceiptJSON(requestId: id, sequence: sequence),
                        "surfaceId": .string(result.surfaceId),
                        "surfaceSetRevision": .integer(result.surfaceSetRevision),
                        "tombstoneId": .string(result.tombstoneId),
                    ])
                }
            case "surface.window.restore":
                guard let tombstoneId = payload["tombstoneId"] as? String,
                      let expected = Self.int64(payload["expectedSurfaceSetRevision"]) else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                let placement = try payload["placement"].map(Self.locklessJSON(fromFoundation:))
                committed = try await adapter.commitMutation(
                    connectionToken: connectionUUID, requestId: id, operation: op
                ) { state, sequence in
                    let result = try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
                        state: &state, tombstoneId: tombstoneId,
                        expectedSurfaceSetRevision: expected, placement: placement
                    )
                    let terminal: SurfAceLocklessJSON = .object([
                        "operationReceipt": Self.locklessReceiptJSON(requestId: id, sequence: sequence),
                        "surface": try Self.locklessJSON(result.surface),
                        "surfaceSetRevision": .integer(result.surfaceSetRevision),
                        "tombstoneId": .string(result.tombstoneId),
                    ])
                    _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
                        in: &state,
                        scopeId: Self.locklessSurfaceScopeId(result.surface.surfaceId),
                        scopeKind: "surface",
                        recordId: "record:\(sequence)",
                        recordClass: .topology,
                        payload: terminal
                    )
                    return terminal
                }
            default:
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            if let failure = locklessCommittedFailureResult(committed, adapter: adapter) { return failure }
            try projectLocklessAuthorityState(await adapter.snapshot())
            let consumableSurfaceId: String? = {
                if let surfaceId = payload["surfaceId"] as? String { return surfaceId }
                guard case .object(let terminal) = committed.responsePayload,
                      case .object(let surface) = terminal["surface"],
                      case .string(let surfaceId) = surface["surfaceId"] else { return nil }
                return surfaceId
            }()
            if let consumableSurfaceId {
                await fanoutLocklessConsumable(
                    scopeId: Self.locklessSurfaceScopeId(consumableSurfaceId), adapter: adapter
                )
            }
            let postSendAction: (@MainActor () async -> Void)?
            #if os(iOS)
            if op == "surface.window.open" || op == "surface.window.restore" {
                postSendAction = {
                    SurfAceSceneActivation.requestNewWindow(source: "lockless:\(op)")
                }
            } else if op == "surface.window.close",
                      let surfaceId = payload["surfaceId"] as? String,
                      let sceneKey = surfaceById[surfaceId]?.sceneKey {
                postSendAction = {
                    guard let scene = UIApplication.shared.connectedScenes.first(where: {
                        $0.session.persistentIdentifier == sceneKey
                    }) else { return }
                    SurfAceSceneActivation.log(
                        event: "scene_destruction_request",
                        fields: [("source", "lockless"), ("surface_id", surfaceId)]
                    )
                    UIApplication.shared.requestSceneSessionDestruction(scene.session, options: nil)
                }
            } else {
                postSendAction = nil
            }
            #else
            postSendAction = nil
            #endif
            return try locklessCommittedResponseResult(
                committed,
                adapter: adapter,
                postSendAction: postSendAction
            )
        } catch let error as SurfAceLocklessTopologyOperationError {
            let code: String
            switch error {
            case .staleTopology: code = "stale_topology"
            case .staleSurfaceSet: code = "stale_surface_set"
            case .paneCapacity: code = "pane_capacity"
            case .paneStateCapacity: code = "pane_state_capacity"
            case .surfaceStateCapacity: code = "surface_state_capacity"
            case .tombstoneCapacity: code = "tombstone_capacity"
            case .tombstoneNotFound: code = "tombstone_not_found"
            default: code = "invalid_payload"
            }
            return await commitLocklessFailure(
                op: op, id: id, code: code, message: String(describing: error),
                error: error, connectionUUID: connectionUUID, adapter: adapter
            )
        } catch let error as SurfAceLocklessRuntimeAdapterError {
            return await commitLocklessFailure(
                op: op, id: id, code: "invalid_payload", message: String(describing: error),
                error: error, connectionUUID: connectionUUID, adapter: adapter
            )
        } catch {
            return await commitLocklessFailure(
                op: op, id: id, code: "invalid_payload", message: String(describing: error),
                error: error, connectionUUID: connectionUUID, adapter: adapter
            )
        }
    }

    nonisolated private static func locklessReceiptJSON(
        requestId: String,
        sequence: Int64
    ) -> SurfAceLocklessJSON {
        .object(["commitSequence": .integer(sequence), "requestId": .string(requestId)])
    }

    func locklessAuthorityForLocalMutation() throws -> SurfAceLocklessRuntimeAdapter {
        try ensureLocklessAdapter()
    }

    func locklessReadinessSnapshot() async throws -> SurfAceLocklessReadinessSnapshot {
        try await locklessAuthorityForLocalMutation().readinessSnapshot()
    }

    func fanoutLocklessCommittedEvent(
        op: String,
        payload: SurfAceLocklessJSON
    ) async {
        guard let locklessAdapter else { return }
        await withLocklessDeliveryTurn {
            let tombstoneBlockedControllerIds = await drainTombstoneReclamationsInCurrentTurn(
                adapter: locklessAdapter
            )
            let blockedControllerIds = await drainControllerRetentionReclamationsInCurrentTurn(
                adapter: locklessAdapter,
                initiallyBlockedControllerIds: tombstoneBlockedControllerIds
            )
            let fanout = await locklessAdapter.fanout(
                afterCommitted: .object(["op": .string(op), "payload": payload])
            )
            let envelope: [String: Any] = [
                "v": 1,
                "type": "event",
                "op": op,
                "eventId": randomHex(prefix: "ev", byteCount: 8),
                "sentAt": timestampNow(),
                "payload": Self.foundationJSON(payload),
            ]
            guard let json = encodeJSON(envelope) else { return }
            for connectionUUID in fanout.connectionTokens {
                guard let connection = locklessConnectionsByConnectionUUID[connectionUUID],
                      !blockedControllerIds.contains(connection.controllerInstanceId) else { continue }
                try? await connection.sender.send(text: json, priority: .event)
            }
        }
    }

    private func drainControllerRetentionReclamations(
        adapter: SurfAceLocklessRuntimeAdapter,
        bypassingAdmissionBarrier: String? = nil
    ) async {
        await withLocklessDeliveryTurn(bypassingAdmissionBarrier: bypassingAdmissionBarrier) {
            let blocked = await drainTombstoneReclamationsInCurrentTurn(adapter: adapter)
            _ = await drainControllerRetentionReclamationsInCurrentTurn(
                adapter: adapter,
                initiallyBlockedControllerIds: blocked
            )
        }
    }

    private func drainTombstoneReclamationsInCurrentTurn(
        adapter: SurfAceLocklessRuntimeAdapter
    ) async -> Set<String> {
        let pending = await adapter.pendingTombstoneReclamations()
        guard !pending.isEmpty else { return [] }
        var blockedControllerIds: Set<String> = []
        for delivery in pending {
            let record = delivery.record
            let diagnosticFields: [(String, CustomStringConvertible?)] = [
                ("event_id", record.eventId),
                ("commit_sequence", record.commitSequence),
                ("tombstone_id", record.tombstoneId),
                ("surface_id", record.surfaceId),
                ("pane_id", record.paneId),
                ("closed_sequence", record.closedSequence),
                ("bytes", record.bytes),
                ("kind", record.kind.rawValue),
                ("max_retained_tombstones", record.maxRetainedTombstones),
                ("max_retained_tombstone_bytes", record.maxRetainedTombstoneBytes),
                ("nested_live_pane_count", record.nestedLivePaneCount),
                ("nested_pane_tombstone_count", record.nestedPaneTombstoneCount),
                ("unread_frame_count", record.unreadFrameCount),
                ("unread_bytes_discarded", record.unreadBytesDiscarded),
                ("reason", record.reason.rawValue),
            ]
            do {
                try surfAcePersistRetentionDiagnostic(
                    "event=lockless_tombstone_reclaimed \(surfAceDiagnosticFields(diagnosticFields))"
                )
            } catch {
                surfAceLifecycleLog(
                    "event=lockless_tombstone_reclamation_diagnostic_deferred \(error.localizedDescription)"
                )
                return blockedControllerIds.union(delivery.connectionTokensByControllerInstanceId.keys)
            }
            guard let payload = try? Self.locklessJSON(record),
                  case .object(var fields) = payload else {
                return blockedControllerIds.union(delivery.connectionTokensByControllerInstanceId.keys)
            }
            fields.removeValue(forKey: "eventId")
            fields.removeValue(forKey: "deliveredControllerInstanceIds")
            fields.removeValue(forKey: "recipientControllerInstanceIds")
            let envelope: [String: Any] = [
                "v": 1,
                "type": "event",
                "op": "event.tombstone_reclaimed",
                "eventId": record.eventId,
                "sentAt": timestampNow(),
                "payload": Self.foundationJSON(.object(fields)),
            ]
            guard let json = encodeJSON(envelope) else {
                return blockedControllerIds.union(delivery.connectionTokensByControllerInstanceId.keys)
            }
            var deliveredControllerIds: [String] = []
            for controllerId in delivery.connectionTokensByControllerInstanceId.keys.sorted() {
                guard !blockedControllerIds.contains(controllerId),
                      let connectionToken = delivery.connectionTokensByControllerInstanceId[controllerId],
                      let connection = locklessConnectionsByConnectionUUID[connectionToken] else { continue }
                do {
                    try await connection.sender.send(text: json, priority: .event)
                    deliveredControllerIds.append(controllerId)
                } catch {
                    blockedControllerIds.insert(controllerId)
                    surfAceLifecycleLog(
                        "event=lockless_tombstone_reclamation_delivery_deferred event_id=\(record.eventId) controller_instance_id=\(controllerId)"
                    )
                }
            }
            if !deliveredControllerIds.isEmpty || record.recipientControllerInstanceIds.isEmpty {
                try? await adapter.acknowledgeTombstoneReclamation(
                    eventId: record.eventId,
                    deliveredControllerInstanceIds: deliveredControllerIds
                )
            }
        }
        return blockedControllerIds
    }

    private func drainControllerRetentionReclamationsInCurrentTurn(
        adapter: SurfAceLocklessRuntimeAdapter,
        initiallyBlockedControllerIds: Set<String> = []
    ) async -> Set<String> {
        let pending = await adapter.pendingControllerRetentionReclamations()
        guard !pending.isEmpty else { return [] }
        var blockedControllerIds = initiallyBlockedControllerIds
        for delivery in pending {
            let record = delivery.record
            let diagnosticFields: [(String, CustomStringConvertible?)] = [
                ("event_id", record.eventId),
                ("commit_sequence", record.commitSequence),
                ("controller_instance_id", record.controllerInstanceId),
                ("dormant_sequence", record.dormantSequence),
                ("disconnected_at", record.disconnectedAt),
                ("scope_count", record.scopeCount),
                ("surface_count", record.surfaceCount),
                ("tombstone_count", record.tombstoneCount),
                ("cursor_count", record.cursorCount),
                ("cursor_bytes", record.cursorBytes),
                ("live_cursor_count", record.liveCursorCount),
                ("live_cursor_bytes", record.liveCursorBytes),
                ("surface_cursor_count", record.surfaceCursorCount),
                ("surface_cursor_bytes", record.surfaceCursorBytes),
                ("tombstone_cursor_count", record.tombstoneCursorCount),
                ("tombstone_cursor_bytes", record.tombstoneCursorBytes),
                ("registry_bytes", record.registryBytes),
                ("receipt_count", record.receiptCount),
                ("receipt_bytes", record.receiptBytes),
                ("unread_frame_count", record.unreadFrameCount),
                ("unread_record_count", record.unreadRecordCount),
                ("unread_bytes", record.unreadBytes),
                ("unread_frame_count_discarded", record.unreadFrameCountDiscarded),
                ("unread_record_count_discarded", record.unreadRecordCountDiscarded),
                ("unread_bytes_discarded", record.unreadBytesDiscarded),
                ("max_admitted_controller_entries", record.maxAdmittedControllerEntries),
                ("max_dormant_controller_entries", record.maxDormantControllerEntries),
                ("max_dormant_controller_bytes", record.maxDormantControllerBytes),
                ("trigger", record.trigger),
                ("reason", record.reason),
            ]
            do {
                try surfAcePersistRetentionDiagnostic(
                    "event=lockless_controller_retention_reclaimed \(surfAceDiagnosticFields(diagnosticFields))"
                )
            } catch {
                surfAceLifecycleLog(
                    "event=lockless_controller_retention_diagnostic_deferred \(error.localizedDescription)"
                )
                return blockedControllerIds.union(delivery.connectionTokensByControllerInstanceId.keys)
            }
            guard let payload = try? Self.locklessJSON(record),
                  case .object(var fields) = payload else {
                return blockedControllerIds.union(delivery.connectionTokensByControllerInstanceId.keys)
            }
            fields.removeValue(forKey: "eventId")
            fields.removeValue(forKey: "deliveredControllerInstanceIds")
            fields.removeValue(forKey: "recipientControllerInstanceIds")
            let envelope: [String: Any] = [
                "v": 1,
                "type": "event",
                "op": "event.controller_retention_reclaimed",
                "eventId": record.eventId,
                "sentAt": timestampNow(),
                "payload": Self.foundationJSON(.object(fields)),
            ]
            guard let json = encodeJSON(envelope) else {
                return blockedControllerIds.union(delivery.connectionTokensByControllerInstanceId.keys)
            }
            var deliveredControllerIds: [String] = []
            for controllerId in delivery.connectionTokensByControllerInstanceId.keys.sorted() {
                guard !blockedControllerIds.contains(controllerId) else { continue }
                guard let connectionToken = delivery.connectionTokensByControllerInstanceId[controllerId],
                      let connection = locklessConnectionsByConnectionUUID[connectionToken] else { continue }
                do {
                    try await connection.sender.send(text: json, priority: .event)
                    deliveredControllerIds.append(controllerId)
                } catch {
                    blockedControllerIds.insert(controllerId)
                    let deferredFields: [(String, CustomStringConvertible?)] = [
                        ("event_id", record.eventId),
                        ("controller_instance_id", controllerId),
                        ("error", error.localizedDescription),
                    ]
                    surfAceLifecycleLog(
                        "event=lockless_controller_retention_delivery_deferred \(surfAceDiagnosticFields(deferredFields))"
                    )
                }
            }
            if !deliveredControllerIds.isEmpty || record.recipientControllerInstanceIds.isEmpty {
                try? await adapter.acknowledgeControllerRetentionReclamation(
                    eventId: record.eventId,
                    deliveredControllerInstanceIds: deliveredControllerIds
                )
            }
        }
        return blockedControllerIds
    }

    func beginLocklessAdmissionDeliveryBarrier(connectionUUID: String) async {
        await acquireLocklessDeliveryTurn()
        locklessAdmissionDeliveryBarriers.insert(connectionUUID)
        releaseLocklessDeliveryTurn()
    }

    func endLocklessAdmissionDeliveryBarrier(connectionUUID: String) {
        guard locklessAdmissionDeliveryBarriers.remove(connectionUUID) != nil else { return }
        resumeLocklessDeliveryWaiters()
    }

    func withLocklessDeliveryTurn(
        bypassingAdmissionBarrier: String? = nil,
        _ operation: () async -> Void
    ) async {
        await acquireLocklessDeliveryTurn(bypassingAdmissionBarrier: bypassingAdmissionBarrier)
        await operation()
        releaseLocklessDeliveryTurn()
    }

    private func acquireLocklessDeliveryTurn(
        bypassingAdmissionBarrier: String? = nil
    ) async {
        while locklessDeliveryActive
            || locklessAdmissionDeliveryBarriers.contains(where: { $0 != bypassingAdmissionBarrier }) {
            await withCheckedContinuation { continuation in
                locklessDeliveryWaiters.append(continuation)
                locklessDeliveryWaitObserver?()
            }
        }
        locklessDeliveryActive = true
    }

    private func releaseLocklessDeliveryTurn() {
        locklessDeliveryActive = false
        resumeLocklessDeliveryWaiters()
    }

    private func resumeLocklessDeliveryWaiters() {
        let waiters = locklessDeliveryWaiters
        locklessDeliveryWaiters.removeAll()
        waiters.forEach { $0.resume() }
    }

    private func commitLocalMutation(
        adapter: SurfAceLocklessRuntimeAdapter,
        operation: String,
        mutate: @escaping SurfAceLocklessRuntimeAdapter.Mutation
    ) async throws -> SurfAceLocklessLocalCommit {
        try await adapter.commitLocalMutation(operation: operation, mutate: mutate)
    }

    private func fanoutLocklessConsumable(
        scopeId: String,
        adapter: SurfAceLocklessRuntimeAdapter
    ) async {
        await withLocklessDeliveryTurn {
            let blockedControllerIds = await drainControllerRetentionReclamationsInCurrentTurn(
                adapter: adapter
            )
            for projection in await adapter.consumableProjections(scopeId: scopeId) {
                guard let connection = locklessConnectionsByConnectionUUID[projection.connectionToken],
                      !blockedControllerIds.contains(connection.controllerInstanceId) else {
                    continue
                }
                var envelopes: [[String: Any]] = []
                if !projection.delta.records.isEmpty {
                    envelopes.append([
                        "v": 1, "type": "event", "op": "event.lockless_consumable_delta",
                        "eventId": randomHex(prefix: "ev", byteCount: 8), "sentAt": timestampNow(),
                        "payload": (try? Self.jsonObject(projection.delta)) ?? [:],
                    ])
                }
                if let gap = projection.snapshot.cursor.gap {
                    envelopes.append([
                        "v": 1, "type": "event", "op": "event.consumable_overflow",
                        "eventId": randomHex(prefix: "ev", byteCount: 8), "sentAt": timestampNow(),
                        "payload": [
                            "firstRetainedSequence": projection.snapshot.firstRetainedSequence,
                            "gap": (try? Self.jsonObject(gap)) ?? [:],
                            "lastRetainedSequence": projection.snapshot.lastRetainedSequence,
                            "scopeId": scopeId,
                        ],
                    ])
                }
                envelopes.append([
                    "v": 1, "type": "event", "op": "event.consumable_available",
                    "eventId": randomHex(prefix: "ev", byteCount: 8), "sentAt": timestampNow(),
                    "payload": ["scopeId": scopeId],
                ])
                for envelope in envelopes {
                    guard let json = encodeJSON(envelope) else { continue }
                    try? await connection.sender.send(text: json, priority: .event)
                }
            }
        }
    }

    private func ensureLocklessAdapter() throws -> SurfAceLocklessRuntimeAdapter {
        if let locklessAdapter { return locklessAdapter }
        let stateURL: URL
        if let locklessStateURLOverride {
            stateURL = locklessStateURLOverride
        } else {
            guard let applicationSupport = FileManager.default.urls(
                for: .applicationSupportDirectory,
                in: .userDomainMask
            ).first else {
                throw CocoaError(.fileNoSuchFile)
            }
            stateURL = applicationSupport
                .appendingPathComponent("SurfAce", isDirectory: true)
                .appendingPathComponent("lockless-authority-v1.json")
        }
        let store = SurfAceLocklessGenerationStore(stateURL: stateURL)
        let adapter = try SurfAceLocklessRuntimeAdapter(
            store: store,
            legacy: SurfAceLegacyUserDefaultsSnapshot(userDefaults: userDefaults)
        )
        locklessAdapter = adapter
        return adapter
    }

    private static func jsonObject<T: Encodable>(_ value: T) throws -> Any {
        try JSONSerialization.jsonObject(with: JSONEncoder().encode(value))
    }

    private static func foundationJSON(_ value: SurfAceLocklessJSON) -> Any {
        (try? jsonObject(value)) ?? NSNull()
    }

    private static func locklessJSON(fromFoundation value: Any) throws -> SurfAceLocklessJSON {
        try JSONDecoder().decode(
            SurfAceLocklessJSON.self,
            from: JSONSerialization.data(withJSONObject: value)
        )
    }

    private static func int64(_ value: Any?) -> Int64? {
        if let value = value as? Int64 { return value }
        if let value = value as? Int { return Int64(value) }
        if let value = value as? NSNumber { return value.int64Value }
        return nil
    }

    private struct LocklessResumeState {
        var pendingAcks: [SurfAceLocklessConsumableAcknowledgementIntent]
        var unresolvedRequestIds: [String]
    }

    private static func locklessResumeState(from value: Any?) throws -> LocklessResumeState {
        guard let value else { return LocklessResumeState(pendingAcks: [], unresolvedRequestIds: []) }
        guard let resume = value as? [String: Any],
              let rawAcks = resume["pendingAcks"] as? [[String: Any]],
              let scopes = resume["scopes"] as? [String: Any] else {
            throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
        }
        guard Set(resume.keys).isSubset(of: ["pendingAcks", "scopes", "unresolvedRequestIds"]),
              scopes.allSatisfy({ scopeId, value in
                  guard !scopeId.isEmpty,
                        let cursor = value as? [String: Any],
                        Set(cursor.keys) == ["cursor", "gapGeneration"],
                        let position = int64(cursor["cursor"]), position > 0,
                        let gapGeneration = int64(cursor["gapGeneration"]), gapGeneration >= 0 else {
                      return false
                  }
                  return true
              }) else {
            throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
        }
        let pendingAcks = try rawAcks.map { acknowledgement in
            guard Set(acknowledgement.keys).isSubset(of: ["cursor", "gapGeneration", "scopeId"]) else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            guard let scopeId = acknowledgement["scopeId"] as? String,
                  !scopeId.isEmpty,
                  let cursor = int64(acknowledgement["cursor"]),
                  cursor > 0 else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            let gapGeneration = int64(acknowledgement["gapGeneration"])
            if let gapGeneration, gapGeneration < 0 {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            return SurfAceLocklessConsumableAcknowledgementIntent(
                cursor: cursor, gapGeneration: gapGeneration, scopeId: scopeId
            )
        }
        let unresolvedRequestIds: [String]
        if let raw = resume["unresolvedRequestIds"] {
            guard let ids = raw as? [String], ids.allSatisfy({ !$0.isEmpty }) else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            unresolvedRequestIds = ids
        } else {
            unresolvedRequestIds = []
        }
        return LocklessResumeState(
            pendingAcks: pendingAcks, unresolvedRequestIds: unresolvedRequestIds
        )
    }

    private func applyNegotiatedModes(_ state: SurfAceLocklessAuthorityState) {
        legacyNegotiatedSurfaceIds = Set(
            state.negotiatedModes.compactMap { surfaceId, mode in
                mode == .legacy ? surfaceId : nil
            }
        )
    }

    nonisolated private static func locklessSurfaceScopeId(_ surfaceId: String) -> String {
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        let encoded = surfaceId.addingPercentEncoding(withAllowedCharacters: unreserved) ?? surfaceId
        return "surface:\(encoded)"
    }

    nonisolated private static func locklessPaneScopeId(surfaceId: String, paneId: Int64) -> String {
        "pane:\(locklessSurfaceScopeId(surfaceId).dropFirst("surface:".count)):\(paneId)"
    }

    private func handlePairRequest(
        id: String,
        payload: [String: Any],
        socket: SurfAceWebSocket,
        sender: SurfAceOutboundSender,
        connectionUUID: String
    ) async -> SurfAceProcessedRequestResult {
        if SurfAceLocklessTargetAdmission.isLocklessRequest(payload) {
            guard SurfAceLocklessTargetAdmission.platformPermitsLockless,
                  SurfAceLocklessTargetAdmission.implementationComplete else {
                let reason = SurfAceLocklessTargetAdmission.platformPermitsLockless
                    ? "native_lockless_contract_incomplete"
                    : "target_not_admitted"
                return SurfAceProcessedRequestResult(
                    responseObject: makeErrorResponse(
                        op: "pair.request",
                        id: id,
                        code: "unsupported_capability",
                        message: reason
                    ),
                    postSendPairCommit: nil
                )
            }
            return await handleLocklessPairRequest(
                id: id,
                payload: payload,
                socket: socket,
                sender: sender,
                connectionUUID: connectionUUID
            )
        }
        let takeover = payload["takeover"] as? Bool ?? false
        let resumePayload = payload["resume"] as? [String: Any]
        let resumeSessionId = resumePayload?["sessionId"] as? String
        let restoreAttemptId = payload["restoreAttemptId"] as? String
        surfAceGatewayLog(
            "event=pair_request_received \(surfAceDiagnosticFields([("connection_uuid", connectionUUID), ("provider_id", payload["providerId"] as? String), ("restore_attempt_id", restoreAttemptId), ("resume_session_id", resumeSessionId), ("surface_id", payload["surfaceId"] as? String), ("takeover", takeover)]))"
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

        if let adapter = locklessAdapter {
            do {
                let state = try await adapter.negotiateLegacySurface(surfaceId)
                applyNegotiatedModes(state)
            } catch SurfAceLocklessRuntimeAdapterError.capabilityMismatch {
                return SurfAceProcessedRequestResult(
                    responseObject: makeErrorResponse(
                        op: "pair.request", id: id, code: "capability_mismatch",
                        message: "surface is already negotiated in lockless mode"
                    ),
                    postSendPairCommit: nil
                )
            } catch {
                return SurfAceProcessedRequestResult(
                    responseObject: makeErrorResponse(
                        op: "pair.request", id: id, code: "client_state_unavailable",
                        message: error.localizedDescription
                    ),
                    postSendPairCommit: nil
                )
            }
        }

        let activeSession = activeSessions[surfaceId]
        let ownershipLock = ownershipLocksBySurfaceId[surfaceId]
        let resumed: Bool
        let sessionId: String
        let ownershipEpoch: Int
        var supersededSession: SurfAceSessionState? = nil

        if let ownershipLock {
            if ownershipLock.providerId == providerId {
                if resumeSessionId == ownershipLock.sessionId {
                    resumed = true
                    sessionId = ownershipLock.sessionId
                    ownershipEpoch = ownershipLock.ownershipEpoch
                    surfAceGatewayLog(
                        "event=\(takeover ? "pair_request_takeover_resumed" : "pair_request_resumed") \(surfAceDiagnosticFields([("provider_id", providerId), ("session_id", sessionId), ("surface_id", surfaceId)]))"
                    )
                    if let activeSession, activeSession.connectionUUID != connectionUUID {
                        supersededSession = activeSession
                    }
                } else {
                    resumed = false
                    sessionId = randomHex(prefix: "sa", byteCount: 12)
                    ownershipEpoch = ownershipLock.ownershipEpoch + 1
                    surfAceGatewayLog(
                        "event=\(takeover ? "pair_request_explicit_takeover" : "pair_request_same_provider_fresh_admission") \(surfAceDiagnosticFields([("active_session", activeSession != nil), ("previous_provider_id", ownershipLock.providerId), ("previous_session_id", ownershipLock.sessionId), ("provider_id", providerId), ("received_session_id", resumeSessionId ?? "nil"), ("same_provider", true), ("surface_id", surfaceId)]))"
                    )
                    if let activeSession, activeSession.connectionUUID != connectionUUID {
                        supersededSession = activeSession
                    }
                }
            } else if takeover {
                surfAceGatewayLog(
                    "event=pair_request_explicit_takeover \(surfAceDiagnosticFields([("active_session", activeSession != nil), ("previous_provider_id", ownershipLock.providerId), ("previous_session_id", ownershipLock.sessionId), ("provider_id", providerId), ("same_provider", false), ("surface_id", surfaceId)]))"
                )
                resumed = false
                sessionId = randomHex(prefix: "sa", byteCount: 12)
                ownershipEpoch = ownershipLock.ownershipEpoch + 1
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

        if !resumed {
            applyFreshProviderAdmissionTopology(
                surface: surface,
                windowLabel: providerWindowLabel,
                initialPaneId: providerInitialPaneId,
                initialPaneLabel: providerInitialPaneLabel,
                requestId: id
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
            "event=pair_response_ready \(surfAceDiagnosticFields([("content_count", surface.panes.filter { $0.currentEntry.contentId != nil }.count), ("pane_count", surface.panes.count), ("restore_attempt_id", restoreAttemptId), ("resumed", resumed), ("session_id", sessionId), ("surface_id", surfaceId)]))"
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
                        var paneState: [String: Any] = [
                            "paneId": pane.paneId,
                            "paneLineageId": pane.paneLineageId,
                            "paneLabel": pane.paneLabel,
                            "currentContentId": jsonValue(pane.currentEntry.contentId),
                            "currentRevision": pane.currentEntry.revision,
                            "contentType": jsonValue(pane.currentEntry.contentType?.rawValue),
                        ]
                        if let display = contentDisplayPayload(for: pane.currentEntry) {
                            paneState["display"] = display
                        }
                        return paneState
                    },
                    "layout": topologyLayoutPayload(surface.paneLayout),
                    "topologyRevision": surface.topologyEpoch,
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

    private func handleSurfaceWindowOpen(id: String, payload: [String: Any], connectionUUID: String) -> [String: Any] {
        guard let (surfaceId, _) = pairedSurface(for: connectionUUID),
              let activeSession = activeSessions[surfaceId],
              let ownershipLock = ownershipLocksBySurfaceId[surfaceId] else {
            return makeErrorResponse(op: "surface.window.open", id: id, code: "not_paired", message: "pair.request required")
        }
        guard activeSession.connectionUUID == connectionUUID,
              ownershipLock.providerId == activeSession.providerId else {
            return makeErrorResponse(op: "surface.window.open", id: id, code: "not_lock_owner", message: "Only the current lock owner may open Surf Ace windows")
        }

        let requestedBy = payload["requestedBy"] as? String ?? "provider_tool"
        #if os(visionOS)
        let accepted = UIApplication.shared.supportsMultipleScenes
        if accepted {
            SurfAceSceneActivation.requestNewWindow(source: "provider:\(requestedBy)")
        }
        #else
        let accepted = false
        #endif
        return [
            "v": 1,
            "type": "response",
            "op": "surface.window.open",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "accepted": accepted,
            ],
        ]
    }

    private func handleSurfaceWindowClose(id: String, payload: [String: Any], connectionUUID: String) -> [String: Any] {
        guard let (surfaceId, surface) = pairedSurface(for: connectionUUID),
              let activeSession = activeSessions[surfaceId],
              let ownershipLock = ownershipLocksBySurfaceId[surfaceId] else {
            return makeErrorResponse(op: "surface.window.close", id: id, code: "not_paired", message: "pair.request required")
        }
        guard activeSession.connectionUUID == connectionUUID,
              ownershipLock.providerId == activeSession.providerId else {
            return makeErrorResponse(op: "surface.window.close", id: id, code: "not_lock_owner", message: "Only the current lock owner may close this Surf Ace window")
        }

        let requestedBy = payload["requestedBy"] as? String ?? "provider_tool"
        #if os(visionOS)
        let scene = UIApplication.shared.connectedScenes.first { $0.session.persistentIdentifier == surface.sceneKey }
        if let scene {
            SurfAceSceneActivation.log(event: "scene_destruction_request", fields: [("source", "provider:\(requestedBy)"), ("surface_id", surfaceId)])
            UIApplication.shared.requestSceneSessionDestruction(scene.session, options: nil)
        }
        let closed = scene != nil
        #else
        _ = requestedBy
        let closed = false
        #endif
        return [
            "v": 1,
            "type": "response",
            "op": "surface.window.close",
            "id": id,
            "ok": true,
            "sentAt": timestampNow(),
            "payload": [
                "closed": closed,
                "surfaceId": surfaceId,
            ],
        ]
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
                    var paneState: [String: Any] = [
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
                    if let display = contentDisplayPayload(for: pane.currentEntry) {
                        paneState["display"] = display
                    }
                    return paneState
                },
            ],
        ]
    }

    private func handleTopologyApply(id: String, payload: [String: Any], connectionUUID: String) -> [String: Any] {
        surfAceGatewayLog(
            "event=topology_apply_receive \(surfAceDiagnosticFields([("connection_uuid", connectionUUID), ("pane_count", (payload["panes"] as? [[String: Any]])?.count), ("surface_id", payload["surfaceId"] as? String), ("topology_revision", payload["topologyRevision"] as? Int), ("window_label", payload["windowLabel"] as? String)]))"
        )
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
        surfAceGatewayLog(
            "event=topology_apply_applied \(surfAceDiagnosticFields([("active_pane_id", surface.activeKeyboardPaneId), ("pane_ids", layout.paneIDs.map(String.init).joined(separator: ",")), ("surface_id", surfaceId), ("topology_revision", topologyRevision), ("window_label", windowLabel)]))"
        )

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

    func handleContentApply(id: String, payload: [String: Any], surfaceId: String) async -> [String: Any] {
        guard let paneId = payload["paneId"] as? Int,
              let pane = pane(surfaceId: surfaceId, paneId: paneId),
              let revision = payload["revision"] as? Int else {
            return makeErrorResponse(op: "content.apply", id: id, code: "invalid_payload", message: "paneId and revision are required")
        }
        let restoreAttemptId = payload["restoreAttemptId"] as? String
        surfAceGatewayLog(
            "event=incoming_content_apply \(surfAceDiagnosticFields([("clear", payload["clear"] as? Bool), ("content_id", payload["contentId"] as? String), ("pane_id", paneId), ("restore_attempt_id", restoreAttemptId), ("revision", revision), ("surface_id", surfaceId)]))"
        )

        if let clear = payload["clear"] as? Bool, clear {
            guard revision == pane.currentEntry.revision + 1 else {
                return staleRevisionResponse(op: "content.apply", id: id, expectedRevision: pane.currentEntry.revision + 1)
            }
            guard !pane.annotationMode else {
                pane.toast = "Finish annotation (Done) to navigate"
                return makeErrorResponse(op: "content.apply", id: id, code: "invalid_operation", message: "annotation mode is active")
            }
            if !surfAceEntryIsVisibleEmpty(pane.currentEntry) {
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
            surfAceLifecycleLog(
                "event=render_transition_empty \(surfAceDiagnosticFields([("actor", "content.apply.clear"), ("pane_id", paneId), ("restore_attempt_id", restoreAttemptId), ("revision", revision), ("surface_id", surfaceId)]))"
            )
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
        applyRestoredDrawingsPayload(payload["restoredDrawings"], to: pane)
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

    func materializeTargetApply(id: String, payload: [String: Any], surfaceId: String) async -> [String: Any] {
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
              requiredCapabilities.contains("target.browser_url.v1"),
              targetCapabilitiesSupport(requiredCapabilities),
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

        if !surfAceEntryIsVisibleEmpty(pane.currentEntry) {
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
        pane.currentEntry.senderDisplayName = SurfAceRuntime.senderDisplayName(
            from: payload["display"] as? [String: Any]
        )
        pane.currentEntry.provenanceDisplayName = SurfAceRuntime.provenanceDisplayName(
            from: payload["display"] as? [String: Any]
        )
        let displayProvenance = (payload["display"] as? [String: Any])?["provenance"] as? [String: Any]
        pane.currentEntry.provenanceSessionKey = SurfAceRuntime.nonEmptyString(displayProvenance?["sessionKey"])
        pane.currentEntry.provenanceSource = SurfAceRuntime.nonEmptyString(displayProvenance?["source"])
        pane.currentEntry.provenanceAgentId = SurfAceRuntime.nonEmptyString(displayProvenance?["agentId"])
        pane.currentEntry.provenanceStreamLabel = SurfAceRuntime.nonEmptyString(displayProvenance?["streamLabel"])
        pane.currentEntry.provenancePushedAt = SurfAceRuntime.nonEmptyString(displayProvenance?["pushedAt"])
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
            targetHeader: payload["targetHeader"] as? [String: Any],
            targetPayload: targetPayload,
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
            errorDomain: navigationResult.errorDomain,
            errorCode: navigationResult.errorCode,
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

    private func targetCapabilitiesSupport(_ requiredCapabilities: [String]) -> Bool {
        requiredCapabilities.allSatisfy { targetCapabilities.contains($0) }
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
              let newPaneLabels = surfAceValidatedProviderNewPaneLabels(from: payload["newPaneLabels"], count: count),
              count >= 2,
              newPaneIds.count == count - 1,
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
        applyRestoredDrawingsPayload(payload["restoredDrawings"], to: pane)
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
        let restoreAttemptId = payload["restoreAttemptId"] as? String
        surfAceGatewayLog(
            "event=incoming_content_clear \(surfAceDiagnosticFields([("pane_id", paneId), ("restore_attempt_id", restoreAttemptId), ("revision", revision), ("surface_id", surfaceId)]))"
        )

        guard revision == pane.currentEntry.revision + 1 else {
            return staleRevisionResponse(op: "content.clear", id: id, expectedRevision: pane.currentEntry.revision + 1)
        }
        guard !pane.annotationMode else {
            pane.toast = "Finish annotation (Done) to navigate"
            return makeErrorResponse(op: "content.clear", id: id, code: "invalid_operation", message: "annotation mode is active")
        }

        if !surfAceEntryIsVisibleEmpty(pane.currentEntry) {
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
        surfAceLifecycleLog(
            "event=render_transition_empty \(surfAceDiagnosticFields([("actor", "content.clear"), ("pane_id", paneId), ("restore_attempt_id", restoreAttemptId), ("revision", revision), ("surface_id", surfaceId)]))"
        )
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

        let providerMatches = payload["surfaceId"] as? String == surfaceId &&
            payload["providerId"] as? String == session.providerId &&
            ownershipLock.providerId == session.providerId
        if providerMatches,
           ((payload["sessionId"] as? String) != session.sessionId ||
            (payload["ownershipEpoch"] as? Int) != session.ownershipEpoch ||
            ownershipLock.sessionId != session.sessionId) {
            surfAceGatewayLog(
                "event=authority_state_same_provider_session_metadata_mismatch \(surfAceDiagnosticFields([("active_ownership_epoch", session.ownershipEpoch), ("active_session_id", session.sessionId), ("provider_id", session.providerId), ("received_ownership_epoch", payload["ownershipEpoch"] as? Int), ("received_session_id", payload["sessionId"] as? String), ("surface_id", surfaceId)]))"
            )
        }
        if providerMatches,
           let providerWindowLabel = surfAceValidatedProviderWindowLabel(from: payload["windowLabel"]),
           providerWindowLabel != surface.windowLabel {
            applyProviderWindowLabel(surface: surface, windowLabel: providerWindowLabel)
        }
        if providerMatches,
           let providerPaneIdentities = surfAceProviderAuthorityPaneIdentityMap(
            from: payload,
            matching: surface.panes.map {
                SurfAceAuthorityPaneIdentity(
                    paneId: $0.paneId,
                    paneLabel: $0.paneLabel,
                    paneLineageId: $0.paneLineageId
                )
            }
           ) {
            applyProviderAuthorityPaneIdentities(surface: surface, providerPaneIdentities: providerPaneIdentities)
        } else if providerMatches {
            let paneCount = (payload["panes"] as? [[String: Any]])?.count
            surfAceGatewayLog(
                "event=authority_state_provider_topology_pending \(surfAceDiagnosticFields([("pane_count", paneCount), ("provider_id", session.providerId), ("surface_id", surfaceId)]))"
            )
        }

        let reason: String?
        if payload["surfaceId"] as? String != surfaceId {
            reason = "surface_id_mismatch"
        } else if payload["providerId"] as? String != session.providerId ||
                    ownershipLock.providerId != session.providerId {
            reason = "session_identity_mismatch"
        } else if surfAceValidatedProviderWindowLabel(from: payload["windowLabel"]) == nil {
            reason = "window_label_mismatch"
        } else if payload["actionable"] as? Bool != true {
            reason = payload["reason"] as? String ?? "provider_not_actionable"
        } else {
            reason = nil
        }
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
        endLocklessAdmissionDeliveryBarrier(connectionUUID: connectionUUID)
        if locklessConnectionsByConnectionUUID.removeValue(forKey: connectionUUID) != nil {
            try? await locklessAdapter?.disconnect(
                connectionToken: connectionUUID,
                disconnectedAt: timestampNow()
            )
            if let locklessAdapter {
                await drainControllerRetentionReclamations(adapter: locklessAdapter)
            }
            return
        }
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

    private func contentDisplayPayload(for entry: SurfAcePaneEntry) -> [String: Any]? {
        var display: [String: Any] = [:]
        if let title = entry.title, !title.isEmpty {
            display["title"] = title
        }
        if let senderDisplayName = entry.senderDisplayName, !senderDisplayName.isEmpty {
            display["senderDisplayName"] = senderDisplayName
        }

        var provenance: [String: Any] = [:]
        if let displayName = entry.provenanceDisplayName, !displayName.isEmpty {
            provenance["displayName"] = displayName
        }
        if let sessionKey = entry.provenanceSessionKey, !sessionKey.isEmpty {
            provenance["sessionKey"] = sessionKey
        }
        if let source = entry.provenanceSource, !source.isEmpty {
            provenance["source"] = source
        }
        if let agentId = entry.provenanceAgentId, !agentId.isEmpty {
            provenance["agentId"] = agentId
        }
        if let streamLabel = entry.provenanceStreamLabel, !streamLabel.isEmpty {
            provenance["streamLabel"] = streamLabel
        }
        if let pushedAt = entry.provenancePushedAt, !pushedAt.isEmpty {
            provenance["pushedAt"] = pushedAt
        }
        if !provenance.isEmpty {
            display["provenance"] = provenance
        }
        return display.isEmpty ? nil : display
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
        let nextLayout = surface.paneLayout.updatingSplitWeights(path: path, weights: weights)
        if let adapter = locklessAdapter, !legacyNegotiatedSurfaceIds.contains(surfaceId) {
            do {
                let topology = try canonicalTopologyJSON(
                    from: SurfAcePersistedPaneLayoutNode(from: nextLayout)
                )
                Task { @MainActor in
                    await commitLocalResize(
                        adapter: adapter,
                        surfaceId: surfaceId,
                        topology: topology
                    )
                }
            } catch {
                endpointError = "Lockless resize encoding failed: \(error.localizedDescription)"
            }
            return
        }
        surface.paneLayout = nextLayout
        surface.topologyEpoch += 1
        persistSurfaceTopology(surfaceId: surfaceId)
        sendLifecycleEvent(
            surfaceId: surfaceId,
            op: "event.topology_changed",
            payload: topologyChangedPayload(for: surface)
        )
    }

    private func commitLocalResize(
        adapter: SurfAceLocklessRuntimeAdapter,
        surfaceId: String,
        topology: SurfAceLocklessJSON
    ) async {
        do {
            _ = try await commitLocalMutation(adapter: adapter, operation: "local.topology.resize") { state, sequence in
                guard var surface = state.liveSurfaces[surfaceId] else {
                    throw SurfAceLocklessAuthorityError.invalidState("local_resize_surface")
                }
                surface.topology = topology
                surface.topologyRevision += 1
                surface.surfaceRevision += 1
                state.liveSurfaces[surfaceId] = surface
                return .object([
                    "commitSequence": .integer(sequence),
                    "surfaceId": .string(surfaceId),
                    "topologyRevision": .integer(surface.topologyRevision),
                ])
            }
            try projectLocklessAuthorityState(await adapter.snapshot())
            guard let surface = surfaceById[surfaceId] else { return }
            await fanoutLocklessCommittedEvent(
                op: "event.topology_changed",
                payload: .object([
                    "surfaceId": .string(surfaceId),
                    "topology": topology,
                    "topologyRevision": .integer(Int64(surface.topologyEpoch)),
                ])
            )
            await drainControllerRetentionReclamations(adapter: adapter)
        } catch {
            endpointError = "Lockless resize mutation failed: \(error.localizedDescription)"
        }
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
        let restored = pane.currentEntry.drawingData.isEmpty && !pane.activeStrokes.isEmpty
            ? bridge.restoreDrawingStrokes(pane.activeStrokes)
            : bridge.restoreDrawing(from: pane.currentEntry.drawingData, strokes: pane.activeStrokes)
        let hasPersistedDrawing = !pane.currentEntry.drawingData.isEmpty || !pane.activeStrokes.isEmpty
        pane.drawingRestoreWarningVisible = hasPersistedDrawing && !restored
        if pane.drawingRestoreWarningVisible {
            pane.toast = "Annotation restore failed"
        }
    }

    private func clearPaneDrawings(_ pane: SurfAcePaneModel) {
        pane.currentEntry.drawingData = Data()
        pane.currentEntry.strokesById.removeAll()
        pane.pendingFlushStrokes.removeAll()
        pane.firstPendingStrokeAt = nil
        pane.lastPendingStrokeAt = nil
        pane.bridge?.clearDrawings()
    }

    private func applyRestoredDrawingsPayload(_ restoredDrawings: Any?, to pane: SurfAcePaneModel) {
        guard let restoredDrawings else { return }
        guard JSONSerialization.isValidJSONObject(restoredDrawings),
              let data = try? JSONSerialization.data(withJSONObject: restoredDrawings),
              let strokes = try? JSONDecoder().decode([SurfAceStroke].self, from: data) else {
            return
        }
        pane.currentEntry.strokesById = Dictionary(uniqueKeysWithValues: strokes.map { ($0.strokeId, $0) })
        pane.currentEntry.drawingData = Data()
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
        let shouldReplaceInPlace = !surfAceEntryIsVisibleEmpty(pane.currentEntry)
            && pane.currentEntry.historyOwnerToken == historyOwnerToken

        if shouldReplaceInPlace {
            pane.currentEntry = nextEntry
            return nil
        }

        var historyInfo: [String: Any]?
        if !surfAceEntryIsVisibleEmpty(pane.currentEntry) {
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
        surfAceLifecycleLog(
            "event=topology_restore_attempt \(surfAceDiagnosticFields([("initial_pane_id", initialPaneId), ("initial_pane_label", initialPaneLabel), ("pane_ids", surface.panes.map { String($0.paneId) }.joined(separator: ",")), ("surface_id", surface.surfaceId), ("window_label", windowLabel)]))"
        )
    }

    func applyFreshProviderAdmissionTopology(
        surface: SurfAceSurfaceModel,
        windowLabel: String,
        initialPaneId: Int,
        initialPaneLabel: Int,
        requestId: String?
    ) {
        if hasRecoverablePairState(surface: surface) {
            applyProviderWindowLabel(surface: surface, windowLabel: windowLabel)
            persistSurfaceTopology(surfaceId: surface.surfaceId)
            surfAceGatewayLog(
                "event=pair_request_preserve_persisted_topology \(surfAceDiagnosticFields([("pane_count", surface.panes.count), ("request_id", requestId), ("surface_id", surface.surfaceId)]))"
            )
            return
        }

        resetProviderBootstrapTopology(
            surface: surface,
            windowLabel: windowLabel,
            initialPaneId: initialPaneId,
            initialPaneLabel: initialPaneLabel
        )
    }

    private func hasRecoverablePairState(surface: SurfAceSurfaceModel) -> Bool {
        let contentPaneCount = surface.panes.filter { pane in
            pane.currentEntry.contentId != nil || pane.currentEntry.contentType != nil
        }.count
        let result = surface.topologyEpoch > 0 || surface.panes.count > 1 || contentPaneCount > 0
        surfAceGatewayLog(
            "event=pair_recoverable_state_decision \(surfAceDiagnosticFields([("content_pane_count", contentPaneCount), ("pane_count", surface.panes.count), ("result", result), ("surface_id", surface.surfaceId), ("topology_revision", surface.topologyEpoch)]))"
        )
        return result
    }

    private func resetProviderBootstrapTopology(
        surface: SurfAceSurfaceModel,
        windowLabel: String,
        initialPaneId: Int,
        initialPaneLabel: Int
    ) {
        applyProviderWindowLabel(surface: surface, windowLabel: windowLabel)
        guard initialPaneId > 0, initialPaneLabel > 0 else {
            return
        }
        if surface.panesById.count == 1,
           case .leaf(let currentPaneId, _) = surface.paneLayout,
           let currentPane = surface.panesById[currentPaneId],
           surfAcePaneIsPristineProviderBootstrap(currentPane) {
            if currentPaneId != initialPaneId {
                surface.panesById.removeValue(forKey: currentPaneId)
                currentPane.paneId = initialPaneId
                surface.panesById[initialPaneId] = currentPane
                surface.paneLayout = .leaf(initialPaneId)
                surface.activeKeyboardPaneId = initialPaneId
            }
            currentPane.paneLabel = initialPaneLabel
            surface.providerTopologyInitialized = true
            persistSurfaceTopology(surfaceId: surface.surfaceId)
            return
        }
        surface.panesById = [
            initialPaneId: SurfAcePaneModel(paneId: initialPaneId, paneLabel: initialPaneLabel)
        ]
        surface.paneLayout = .leaf(initialPaneId)
        surface.activeKeyboardPaneId = initialPaneId
        surface.providerTopologyInitialized = true
        surface.topologyEpoch += 1
        surface.geometryRevision += 1
        persistSurfaceTopology(surfaceId: surface.surfaceId)
        surfAceLifecycleLog(
            "event=provider_bootstrap_topology_reset \(surfAceDiagnosticFields([("initial_pane_id", initialPaneId), ("initial_pane_label", initialPaneLabel), ("surface_id", surface.surfaceId), ("window_label", windowLabel)]))"
        )
    }

    private func applyProviderWindowLabel(surface: SurfAceSurfaceModel, windowLabel: String) {
        guard surface.windowLabel != windowLabel else { return }
        surface.windowLabel = windowLabel
        surface.name = "\(screenName) \(windowLabel.uppercased())"
        persistSurfaceTopology(surfaceId: surface.surfaceId)
        surfAceLifecycleLog(
            "event=surface_identity_changed \(surfAceDiagnosticFields([("surface_id", surface.surfaceId), ("window_label", windowLabel)]))"
        )
    }

    private func applyProviderAuthorityPaneIdentities(
        surface: SurfAceSurfaceModel,
        providerPaneIdentities: [Int: SurfAceAuthorityPaneIdentity]
    ) {
        var changed = false
        for pane in surface.panes {
            guard let providerPane = providerPaneIdentities[pane.paneId] else {
                continue
            }
            if pane.paneLabel != providerPane.paneLabel {
                pane.paneLabel = providerPane.paneLabel
                changed = true
            }
            if pane.paneLineageId != providerPane.paneLineageId {
                pane.paneLineageId = providerPane.paneLineageId
                changed = true
            }
        }
        if changed {
            surface.topologyEpoch += 1
            persistSurfaceTopology(surfaceId: surface.surfaceId)
        }
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

    private func renderableEntry(_ entry: SurfAcePaneEntry) -> SurfAcePaneEntry? {
        surfAceEntryIsVisibleEmpty(entry) ? nil : entry
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

    private func locklessAdapterErrorResult(
        op: String,
        id: String,
        error: SurfAceLocklessRuntimeAdapterError
    ) -> SurfAceProcessedRequestResult {
        let mapped = Self.locklessProtocolError(for: error)
        var details = mapped.details.mapValues { $0 as Any }
        details["targetErrorCode"] = mapped.targetErrorCode
        return SurfAceProcessedRequestResult(
            responseObject: makeErrorResponse(
                op: op,
                id: id,
                code: mapped.code,
                message: mapped.message,
                details: details.isEmpty ? nil : details
            ),
            postSendPairCommit: nil
        )
    }

    private func locklessCommittedFailureResult(
        _ committed: SurfAceLocklessCommittedMutation,
        adapter: SurfAceLocklessRuntimeAdapter
    ) -> SurfAceProcessedRequestResult? {
        guard committed.outcome == "resolved_failure" else { return nil }
        return try? locklessCommittedResponseResult(committed, adapter: adapter)
    }

    private func locklessCommittedResponseResult(
        _ committed: SurfAceLocklessCommittedMutation,
        adapter: SurfAceLocklessRuntimeAdapter,
        postSendAction: (@MainActor () async -> Void)? = nil
    ) throws -> SurfAceProcessedRequestResult {
        guard let response = Self.foundationJSON(committed.terminalResponse) as? [String: Any] else {
            throw SurfAceLocklessAuthorityError.invalidState("operation_terminal_response")
        }
        return SurfAceProcessedRequestResult(
            responseObject: response,
            postSendPairCommit: nil,
            postSendAction: { [weak self, weak adapter] in
                guard let self, let adapter else { return }
                if let postSendAction {
                    await postSendAction()
                }
                await self.drainControllerRetentionReclamations(adapter: adapter)
            }
        )
    }

    private func commitLocklessFailure(
        op: String,
        id: String,
        code: String,
        message _: String,
        details: [String: Any]? = nil,
        error: Error,
        connectionUUID: String,
        adapter: SurfAceLocklessRuntimeAdapter
    ) async -> SurfAceProcessedRequestResult {
        if let adapterError = error as? SurfAceLocklessRuntimeAdapterError {
            switch adapterError {
            case .receiptCapacity, .surfaceStateCapacity:
                return locklessAdapterErrorResult(op: op, id: id, error: adapterError)
            default:
                break
            }
        }
        if case .surfaceStateCapacity = error as? SurfAceLocklessTopologyOperationError {
            return SurfAceProcessedRequestResult(
                responseObject: makeErrorResponse(op: op, id: id, code: code, message: code, details: details),
                postSendPairCommit: nil
            )
        }
        let response = makeErrorResponse(op: op, id: id, code: code, message: code, details: details)
        do {
            let exact = try Self.locklessJSON(fromFoundation: response)
            let committed = try await adapter.commitFailedMutation(
                connectionToken: connectionUUID,
                requestId: id,
                operation: op,
                terminalResponse: exact
            )
            return locklessCommittedFailureResult(committed, adapter: adapter) ?? SurfAceProcessedRequestResult(
                responseObject: response, postSendPairCommit: nil
            )
        } catch let adapterError as SurfAceLocklessRuntimeAdapterError {
            return locklessAdapterErrorResult(op: op, id: id, error: adapterError)
        } catch {
            return SurfAceProcessedRequestResult(responseObject: response, postSendPairCommit: nil)
        }
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
        if let targetHeader = target.targetHeader {
            payload["targetHeader"] = targetHeader
        }
        if let targetPayload = target.targetPayload {
            payload["targetPayload"] = targetPayload
        }
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
        errorDomain: String? = nil,
        errorCode: Int? = nil,
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
            payload["errorCode"] = browserURLNavigationErrorCode(errorDomain: errorDomain, errorCode: errorCode)
        }
        return payload
    }

    static func browserURLNavigationErrorCode(errorDomain: String?, errorCode: Int?) -> String {
        if errorDomain == "WebKitErrorDomain", errorCode == 102 {
            return "policy_denied"
        }
        return "materialization_failed"
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
        surfAceLifecycleLog(
            "event=state_restore_read_ok \(surfAceDiagnosticFields([("surface_count", mapping.count), ("surface_ids", mapping.keys.sorted().joined(separator: ","))]))"
        )
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
        guard let provenance = display?["provenance"] as? [String: Any] else { return nil }
        if let displayName = nonEmptyString(provenance["displayName"]) {
            return displayName
        }
        if let streamLabel = nonEmptyString(provenance["streamLabel"]) {
            return streamLabel
        }
        return nil
    }

    private static func senderDisplayName(from display: [String: Any]?) -> String? {
        nonEmptyString(display?["senderDisplayName"])
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let string = value as? String, !string.isEmpty else { return nil }
        return string
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
