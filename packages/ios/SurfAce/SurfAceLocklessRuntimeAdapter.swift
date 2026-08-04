import Foundation

let surfAceTargetCapabilities = ["target.browser_url.v1"]

enum SurfAceLocklessTargetAdmission {
    #if os(iOS)
    static let platformPermitsLockless = true
    #else
    static let platformPermitsLockless = false
    #endif

    static let requiredNetworkOperations: Set<String> = [
        "surfaces.list", "panes.list", "content.set", "content.append", "content.patch",
        "content.clear", "annotations.remove", "snapshot.get", "pane.split", "pane.rename",
        "pane.close", "pane.restore", "topology.apply", "surface.window.open",
        "surface.window.close", "surface.window.restore", "target.apply",
        "operation.receipt.sync", "operation.receipt.ack", "consumable.sync", "consumable.ack", "heartbeat.ping",
    ]
    static let routedNetworkOperations: Set<String> = [
        "surfaces.list", "panes.list", "operation.receipt.sync", "operation.receipt.ack",
        "consumable.sync", "consumable.ack", "heartbeat.ping", "annotations.remove",
        "pane.split", "pane.rename", "pane.close", "pane.restore", "topology.apply",
        "surface.window.open", "surface.window.close", "surface.window.restore",
        "snapshot.get", "target.apply",
        "content.set", "content.append", "content.patch", "content.clear",
    ]
    static let localLifecycleComplete = true
    static var unroutedNetworkOperations: [String] {
        requiredNetworkOperations.subtracting(routedNetworkOperations).sorted()
    }
    static var implementationComplete: Bool {
        localLifecycleComplete && unroutedNetworkOperations.isEmpty
    }

    static var advertisedProtocolFeatures: [String] {
        platformPermitsLockless && implementationComplete ? [surfAceLocklessCapability] : []
    }

    static func isLocklessRequest(_ payload: [String: Any]) -> Bool {
        (payload["protocolFeatures"] as? [String])?.contains(surfAceLocklessCapability) == true
    }
}

enum SurfAceLocklessRuntimeAdapterError: Error, Equatable, Sendable {
    case capabilityMismatch
    case controllerCapacity
    case duplicateLiveController
    case invalidAdmission
    case notPaired
    case receiptCapacity(
        currentBytes: Int64,
        currentCount: Int64,
        prospectiveBytes: Int64,
        prospectiveCount: Int64,
        maxBytes: Int64,
        maxCount: Int64
    )
    case receiptUnavailable
    case surfaceStateCapacity(current: Int64, prospective: Int64, maximum: Int64)
    case stillPending
    case targetPrecommit(code: String, targetErrorCode: String?, message: String)
}

struct SurfAceLocklessAdmissionResult: Equatable, Sendable {
    var controllerInstanceId: String
    var limits: SurfAceLocklessCapacityLimits
    var resumed: Bool
    var receiptResolutions: [SurfAceLocklessJSON]
    var state: SurfAceLocklessAuthorityState
}

struct SurfAceLocklessCommittedMutation: Equatable, Sendable {
    var commitSequence: Int64
    var outcome: String
    var requestId: String
    var responsePayload: SurfAceLocklessJSON
    var terminalResponse: SurfAceLocklessJSON
}

struct SurfAceLocklessLocalCommit: Equatable, Sendable {
    var commitSequence: Int64
    var operation: String
    var result: SurfAceLocklessJSON
}

struct SurfAceLocklessReadinessSnapshot: Equatable, Sendable {
    var fullGenerationLoaded: Bool
    var readyForAdmission: Bool
    var state: SurfAceLocklessAuthorityState
    var targetWorkRecovered: Bool
}

struct SurfAceLocklessFanout: Equatable, Sendable {
    var connectionTokens: [String]
    var event: SurfAceLocklessJSON
}

struct SurfAceLocklessControllerRetentionDelivery: Equatable, Sendable {
    var connectionTokensByControllerInstanceId: [String: String]
    var record: SurfAceLocklessControllerRetentionReclamation
}

struct SurfAceLocklessMaterializationOutcome: Equatable, Sendable {
    var errorCode: String?
    var materializedState: SurfAceLocklessJSON?
    var status: String
}

actor SurfAceLocklessRuntimeAdapter {
    typealias Mutation = @Sendable (
        inout SurfAceLocklessAuthorityState,
        Int64
    ) throws -> SurfAceLocklessJSON
    typealias ConsumablePayload = @Sendable (
        SurfAceLocklessAuthorityState,
        SurfAceLocklessJSON
    ) throws -> SurfAceLocklessJSON

    private let coordinator: SurfAceLocklessTransactionCoordinator
    private let targetIntentAdmissionPreparation: (@Sendable (String) async -> Void)?
    private var connectionByController: [String: String] = [:]
    private var controllerByConnection: [String: String] = [:]
    private var targetWorkRecovered: Bool

    init(
        store: SurfAceLocklessGenerationStore,
        legacy: SurfAceLegacyUserDefaultsSnapshot,
        targetIntentAdmissionPreparation: (@Sendable (String) async -> Void)? = nil
    ) throws {
        self.targetIntentAdmissionPreparation = targetIntentAdmissionPreparation
        let loadedState = try store.load()
        var state: SurfAceLocklessAuthorityState
        if let loadedState {
            state = loadedState
        } else {
            state = try SurfAceLocklessMigration.migrate(legacy)
        }
        try Self.normalizeTopologies(in: &state)
        var restoredLiveController = false
        for controllerId in state.controllers.keys.sorted() {
            guard state.controllers[controllerId]?.status == .live else { continue }
            state.controllers[controllerId]?.status = .dormant
            state.controllers[controllerId]?.dormantSequence = state.sequences.nextDormantSequence
            state.sequences.nextDormantSequence += 1
            restoredLiveController = true
        }
        let reclaimedRestoredController = try !SurfAceLocklessDormantRetention
            .enforceBounds(in: &state, trigger: "restored_state_enforcement").isEmpty
        if restoredLiveController || reclaimedRestoredController || loadedState == nil {
            state.generation += 1
            try store.save(state)
        }
        coordinator = try SurfAceLocklessTransactionCoordinator(state: state, store: store)
        targetWorkRecovered = state.targetApplyWorkItems.isEmpty
    }

    func admit(
        controllerInstanceId: String,
        controllerProductName: String?,
        connectionToken: String,
        projectionCapacityBytes: Int64,
        protocolFeatures: [String],
        surfaceId: String? = nil,
        pendingAcks: [SurfAceLocklessConsumableAcknowledgementIntent] = [],
        unresolvedRequestIds: [String] = []
    ) async throws -> SurfAceLocklessAdmissionResult {
        guard !controllerInstanceId.isEmpty,
              !connectionToken.isEmpty,
              projectionCapacityBytes > 0,
              protocolFeatures.contains(surfAceLocklessCapability) else {
            throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
        }
        guard connectionByController[controllerInstanceId] == nil,
              controllerByConnection[connectionToken] == nil else {
            throw SurfAceLocklessRuntimeAdapterError.duplicateLiveController
        }

        let admission = try await coordinator.transact(trigger: "controller_admission") { state in
            let pendingReclamationCount = state.pendingControllerRetentionReclamations?.count ?? 0
            let requiredProjectionBytes = max(
                state.limits.maxPaneConsumableBytes,
                state.limits.maxSurfaceConsumableBytes
            ) + state.limits.maxConsumableCursorStateBytesPerScope
            guard projectionCapacityBytes >= requiredProjectionBytes else {
                throw SurfAceLocklessRuntimeAdapterError.capabilityMismatch
            }
            if let surfaceId {
                guard state.liveSurfaces[surfaceId] != nil else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                guard state.negotiatedModes[surfaceId] != .legacy else {
                    throw SurfAceLocklessRuntimeAdapterError.capabilityMismatch
                }
                state.negotiatedModes[surfaceId] = .lockless
                try Self.ensureScopes(surfaceId: surfaceId, in: &state)
            }
            if state.controllers[controllerInstanceId]?.status == .live {
                throw SurfAceLocklessRuntimeAdapterError.duplicateLiveController
            }
            let resumed = state.controllers[controllerInstanceId] != nil
            if !resumed && Int64(state.controllers.count) >= state.limits.maxAdmittedControllerEntries {
                guard try SurfAceLocklessDormantRetention.reclaimOldest(
                    in: &state,
                    trigger: "controller_admission",
                    reason: "entry_capacity"
                ) != nil else {
                    throw SurfAceLocklessRuntimeAdapterError.controllerCapacity
                }
            }
            state.controllers[controllerInstanceId] = SurfAceLocklessControllerBundle(
                controllerInstanceId: controllerInstanceId,
                controllerProductName: controllerProductName,
                disconnectedAt: nil,
                dormantSequence: nil,
                pendingOperationReceipts: state.controllers[controllerInstanceId]?.pendingOperationReceipts ?? [:],
                projectionCapacityBytes: projectionCapacityBytes,
                status: .live
            )
            if var pending = state.pendingControllerRetentionReclamations,
               pending.count > pendingReclamationCount {
                for index in pendingReclamationCount..<pending.count {
                    var recipients = pending[index].recipientControllerInstanceIds
                    if !recipients.contains(controllerInstanceId) {
                        recipients.append(controllerInstanceId)
                        recipients.sort()
                    }
                    pending[index].recipientControllerInstanceIds = recipients
                }
                state.pendingControllerRetentionReclamations = pending
            }
            SurfAceLocklessConsumableOperations.admitController(controllerInstanceId, in: &state)
            for acknowledgement in pendingAcks {
                _ = try SurfAceLocklessConsumableOperations.acknowledge(
                    in: &state,
                    controllerInstanceId: controllerInstanceId,
                    scopeId: acknowledgement.scopeId,
                    cursor: acknowledgement.cursor,
                    gapGeneration: acknowledgement.gapGeneration
                )
            }
            let resolutions = Self.receiptResolutions(
                bundle: state.controllers[controllerInstanceId],
                controllerWasKnown: resumed,
                requestIds: unresolvedRequestIds
            )
            return (resumed, resolutions)
        }
        connectionByController[controllerInstanceId] = connectionToken
        controllerByConnection[connectionToken] = controllerInstanceId
        return SurfAceLocklessAdmissionResult(
            controllerInstanceId: controllerInstanceId,
            limits: (await coordinator.snapshot()).limits,
            resumed: admission.0,
            receiptResolutions: admission.1,
            state: await coordinator.snapshot()
        )
    }

    func negotiateLegacySurface(_ surfaceId: String) async throws -> SurfAceLocklessAuthorityState {
        try await coordinator.transact(trigger: "legacy_negotiation") { state in
            guard state.liveSurfaces[surfaceId] != nil else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            guard state.negotiatedModes[surfaceId] != .lockless else {
                throw SurfAceLocklessRuntimeAdapterError.capabilityMismatch
            }
            state.negotiatedModes[surfaceId] = .legacy
            return state
        }
    }

    func disconnect(connectionToken: String, disconnectedAt: Int64) async throws {
        guard let controllerId = controllerByConnection[connectionToken] else { return }
        try await coordinator.transact(trigger: "disconnect") { state in
            guard var bundle = state.controllers[controllerId], bundle.status == .live else {
                throw SurfAceLocklessRuntimeAdapterError.notPaired
            }
            bundle.status = .dormant
            bundle.disconnectedAt = disconnectedAt
            bundle.dormantSequence = state.sequences.nextDormantSequence
            state.sequences.nextDormantSequence += 1
            state.controllers[controllerId] = bundle
        }
        controllerByConnection.removeValue(forKey: connectionToken)
        connectionByController.removeValue(forKey: controllerId)
    }

    func commitMutation(
        connectionToken: String,
        requestId: String,
        operation: String,
        consumableScopeId: String? = nil,
        consumableScopeKind: String? = nil,
        consumableRecordClass: SurfAceLocklessConsumableRecordClass? = nil,
        consumablePayload: ConsumablePayload? = nil,
        mutate: @escaping Mutation
    ) async throws -> SurfAceLocklessCommittedMutation {
        guard let controllerId = controllerByConnection[connectionToken] else {
            throw SurfAceLocklessRuntimeAdapterError.notPaired
        }
        return try await coordinator.transact(trigger: "operation:\(operation)") { state in
            guard var bundle = state.controllers[controllerId], bundle.status == .live else {
                throw SurfAceLocklessRuntimeAdapterError.notPaired
            }
            guard bundle.pendingOperationReceipts[requestId] == nil else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            let pending = Array(bundle.pendingOperationReceipts.values)
            let commitSequence = state.sequences.nextCommitSequence
            let beforeMutation = state
            var responsePayload: SurfAceLocklessJSON = .null
            var terminalResponse: SurfAceLocklessJSON = .null
            var outcome = "resolved_success"
            do {
                responsePayload = try mutate(&state, commitSequence)
                outcome = "resolved_success"
                if let consumableScopeId, let consumableScopeKind, let consumableRecordClass {
                    let recordPayload = try consumablePayload?(state, responsePayload) ?? responsePayload
                    _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
                        in: &state,
                        scopeId: consumableScopeId,
                        scopeKind: consumableScopeKind,
                        recordId: "record:\(commitSequence)",
                        recordClass: consumableRecordClass,
                        payload: recordPayload
                    )
                }
                try Self.normalizeTopologies(in: &state)
                terminalResponse = Self.successResponse(
                    operation: operation,
                    requestId: requestId,
                    payload: responsePayload
                )
            } catch {
                guard let failure = Self.committedFailureResponse(
                    error: error,
                    operation: operation,
                    requestId: requestId,
                    commitSequence: commitSequence
                ) else {
                    throw error
                }
                state = beforeMutation
                terminalResponse = failure
                outcome = "resolved_failure"
            }
            let receipt = try Self.exactReceipt(
                commitSequence: commitSequence,
                operation: operation,
                outcome: outcome,
                requestId: requestId,
                terminalResponse: terminalResponse
            )
            let currentReceiptBytes = pending.reduce(Int64(0)) {
                SurfAceLocklessExactDurableAccounting.saturatingAdd($0, $1.bytes)
            }
            let currentReceiptCount = Int64(pending.count)
            let prospectiveReceiptBytes = SurfAceLocklessExactDurableAccounting.saturatingAdd(
                currentReceiptBytes,
                receipt.bytes
            )
            let prospectiveReceiptCount = currentReceiptCount + 1
            guard prospectiveReceiptCount <= state.limits.maxPendingOperationReceiptsPerController,
                  prospectiveReceiptBytes <= state.limits.maxPendingOperationReceiptBytesPerController else {
                throw SurfAceLocklessRuntimeAdapterError.receiptCapacity(
                    currentBytes: currentReceiptBytes,
                    currentCount: currentReceiptCount,
                    prospectiveBytes: prospectiveReceiptBytes,
                    prospectiveCount: prospectiveReceiptCount,
                    maxBytes: state.limits.maxPendingOperationReceiptBytesPerController,
                    maxCount: state.limits.maxPendingOperationReceiptsPerController
                )
            }
            state.sequences.nextCommitSequence += 1
            bundle.pendingOperationReceipts[requestId] = receipt
            state.controllers[controllerId] = bundle
            return SurfAceLocklessCommittedMutation(
                commitSequence: commitSequence,
                outcome: outcome,
                requestId: requestId,
                responsePayload: responsePayload,
                terminalResponse: terminalResponse
            )
        }
    }

    func commitLocalMutation(
        operation: String,
        mutate: @escaping Mutation
    ) async throws -> SurfAceLocklessLocalCommit {
        try await coordinator.transact(trigger: "local_operation:\(operation)") { state in
            let commitSequence = state.sequences.nextCommitSequence
            let result = try mutate(&state, commitSequence)
            if case .object(let object) = result,
               case .string(let surfaceId) = object["surfaceId"],
               state.liveSurfaces[surfaceId] != nil {
                let recordClass: SurfAceLocklessConsumableRecordClass
                if operation.contains("annotation") {
                    recordClass = .annotationFrame
                } else if operation.contains("history") {
                    recordClass = .history
                } else {
                    recordClass = .topology
                }
                let scopeId: String
                let scopeKind: String
                if case .integer(let paneId) = object["paneId"],
                   state.scopes[Self.paneScopeId(surfaceId: surfaceId, paneId: paneId)] != nil {
                    scopeId = Self.paneScopeId(surfaceId: surfaceId, paneId: paneId)
                    scopeKind = "pane"
                } else {
                    scopeId = Self.surfaceScopeId(surfaceId)
                    scopeKind = "surface"
                }
                _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
                    in: &state,
                    scopeId: scopeId,
                    scopeKind: scopeKind,
                    recordId: "record:\(commitSequence)",
                    recordClass: recordClass,
                    payload: result
                )
            }
            try Self.normalizeTopologies(in: &state)
            state.sequences.nextCommitSequence += 1
            return SurfAceLocklessLocalCommit(
                commitSequence: commitSequence,
                operation: operation,
                result: result
            )
        }
    }

    func commitFailedMutation(
        connectionToken: String,
        requestId: String,
        operation: String,
        terminalResponse: SurfAceLocklessJSON
    ) async throws -> SurfAceLocklessCommittedMutation {
        guard let controllerId = controllerByConnection[connectionToken] else {
            throw SurfAceLocklessRuntimeAdapterError.notPaired
        }
        return try await coordinator.transact(trigger: "operation:\(operation):failure") { state in
            guard var bundle = state.controllers[controllerId], bundle.status == .live else {
                throw SurfAceLocklessRuntimeAdapterError.notPaired
            }
            guard bundle.pendingOperationReceipts[requestId] == nil else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            let pending = Array(bundle.pendingOperationReceipts.values)
            let commitSequence = state.sequences.nextCommitSequence
            let receipt = try Self.exactReceipt(
                commitSequence: commitSequence,
                operation: operation,
                outcome: "resolved_failure",
                requestId: requestId,
                terminalResponse: terminalResponse
            )
            let currentBytes = pending.reduce(Int64(0)) {
                SurfAceLocklessExactDurableAccounting.saturatingAdd($0, $1.bytes)
            }
            let prospectiveBytes = SurfAceLocklessExactDurableAccounting.saturatingAdd(
                currentBytes, receipt.bytes
            )
            let prospectiveCount = Int64(pending.count) + 1
            guard prospectiveCount <= state.limits.maxPendingOperationReceiptsPerController,
                  prospectiveBytes <= state.limits.maxPendingOperationReceiptBytesPerController else {
                throw SurfAceLocklessRuntimeAdapterError.receiptCapacity(
                    currentBytes: currentBytes,
                    currentCount: Int64(pending.count),
                    prospectiveBytes: prospectiveBytes,
                    prospectiveCount: prospectiveCount,
                    maxBytes: state.limits.maxPendingOperationReceiptBytesPerController,
                    maxCount: state.limits.maxPendingOperationReceiptsPerController
                )
            }
            state.sequences.nextCommitSequence += 1
            bundle.pendingOperationReceipts[requestId] = receipt
            state.controllers[controllerId] = bundle
            return SurfAceLocklessCommittedMutation(
                commitSequence: commitSequence,
                outcome: "resolved_failure",
                requestId: requestId,
                responsePayload: .null,
                terminalResponse: terminalResponse
            )
        }
    }

    func resolveReceipts(
        connectionToken: String,
        requestIds: [String]
    ) async throws -> [SurfAceLocklessJSON] {
        guard let controllerId = controllerByConnection[connectionToken] else {
            throw SurfAceLocklessRuntimeAdapterError.notPaired
        }
        let snapshot = await coordinator.snapshot()
        guard let bundle = snapshot.controllers[controllerId] else {
            throw SurfAceLocklessRuntimeAdapterError.receiptUnavailable
        }
        return requestIds.map { requestId in
            guard let receipt = bundle.pendingOperationReceipts[requestId] else {
                return .object(["outcome": .string("not_committed"), "requestId": .string(requestId)])
            }
            if receipt.status == .pending {
                return .object(["outcome": .string("still_pending"), "requestId": .string(requestId)])
            }
            return .object([
                "operationReceipt": .object([
                    "commitSequence": .integer(receipt.commitSequence ?? 0),
                    "requestId": .string(requestId),
                ]),
                "outcome": .string(receipt.outcome ?? "resolved_failure"),
                "requestId": .string(requestId),
                "terminalResponse": receipt.terminalResponse ?? .null,
            ])
        }
    }

    func acknowledgeReceipts(connectionToken: String, requestIds: [String]) async throws {
        guard let controllerId = controllerByConnection[connectionToken] else {
            throw SurfAceLocklessRuntimeAdapterError.notPaired
        }
        try await coordinator.transact(trigger: "operation_receipt_ack") { state in
            guard var bundle = state.controllers[controllerId] else {
                throw SurfAceLocklessRuntimeAdapterError.receiptUnavailable
            }
            for requestId in requestIds {
                guard bundle.pendingOperationReceipts[requestId]?.status == .terminal else {
                    throw SurfAceLocklessRuntimeAdapterError.stillPending
                }
            }
            for requestId in requestIds {
                bundle.pendingOperationReceipts.removeValue(forKey: requestId)
            }
            state.controllers[controllerId] = bundle
        }
    }

    func acknowledgeConsumable(
        connectionToken: String,
        scopeId: String,
        cursor: Int64,
        gapGeneration: Int64?
    ) async throws {
        guard let controllerId = controllerByConnection[connectionToken] else {
            throw SurfAceLocklessRuntimeAdapterError.notPaired
        }
        try await coordinator.transact(trigger: "consumable_ack") { state in
            _ = try SurfAceLocklessConsumableOperations.acknowledge(
                in: &state,
                controllerInstanceId: controllerId,
                scopeId: scopeId,
                cursor: cursor,
                gapGeneration: gapGeneration
            )
        }
    }

    func consumableSnapshots(
        connectionToken: String,
        scopeIds: [String]
    ) async throws -> [SurfAceLocklessConsumableScopeSnapshot] {
        guard let controllerId = controllerByConnection[connectionToken] else {
            throw SurfAceLocklessRuntimeAdapterError.notPaired
        }
        let state = await coordinator.snapshot()
        return try scopeIds.map {
            try SurfAceLocklessConsumableOperations.snapshot(
                in: state, controllerInstanceId: controllerId, scopeId: $0
            )
        }
    }

    func consumableDeltas(
        scopeId: String
    ) async -> [(connectionToken: String, delta: SurfAceLocklessConsumableDelta)] {
        let state = await coordinator.snapshot()
        return controllerByConnection.keys.sorted().compactMap { connectionToken in
            guard let controllerId = controllerByConnection[connectionToken],
                  let delta = try? SurfAceLocklessConsumableOperations.delta(
                    in: state, controllerInstanceId: controllerId, scopeId: scopeId
                  ) else { return nil }
            return (connectionToken, delta)
        }
    }

    func consumableProjections(
        scopeId: String
    ) async -> [(
        connectionToken: String,
        delta: SurfAceLocklessConsumableDelta,
        snapshot: SurfAceLocklessConsumableScopeSnapshot
    )] {
        let state = await coordinator.snapshot()
        return controllerByConnection.keys.sorted().compactMap { connectionToken in
            guard let controllerId = controllerByConnection[connectionToken],
                  let snapshot = try? SurfAceLocklessConsumableOperations.snapshot(
                    in: state, controllerInstanceId: controllerId, scopeId: scopeId
                  ),
                  let delta = try? SurfAceLocklessConsumableOperations.delta(
                    in: state, controllerInstanceId: controllerId, scopeId: scopeId
                  ) else { return nil }
            return (connectionToken, delta, snapshot)
        }
    }

    func commitTargetIntent(
        connectionToken: String,
        operationRequestId: String,
        targetRequestId: String,
        surfaceId: String,
        targetId: String,
        targetEpoch: Int64,
        request: SurfAceLocklessJSON
    ) async throws -> SurfAceLocklessCommittedMutation {
        let controllerId = controllerByConnection[connectionToken]
        guard let controllerId else { throw SurfAceLocklessRuntimeAdapterError.notPaired }
        await targetIntentAdmissionPreparation?(operationRequestId)
        return try await commitMutation(
            connectionToken: connectionToken,
            requestId: operationRequestId,
            operation: "target.apply"
        ) { state, sequence in
            guard let surface = state.liveSurfaces[surfaceId] else {
                throw Self.targetPrecommitFailure(
                    targetErrorCode: "pane_lineage_missing",
                    message: "target.apply surface is not live"
                )
            }
            let normalizedRequest = try Self.validateAndNormalizeTargetIntent(
                request,
                surface: surface
            )
            var work = SurfAceLocklessTargetWorkItem(
                bytes: 0,
                controllerInstanceId: controllerId,
                intentCommitSequence: sequence,
                operationRequestId: operationRequestId,
                request: normalizedRequest,
                state: .intentCommitted,
                surfaceId: surfaceId,
                targetEpoch: targetEpoch,
                targetId: targetId,
                targetRequestId: targetRequestId
            )
            work.bytes = try SurfAceLocklessExactDurableAccounting.targetWorkBytes(work)
            let current = SurfAceLocklessExactDurableAccounting.saturatingAdd(
                try SurfAceLocklessTopologyOperations.surfaceBaseBytes(surface),
                state.targetApplyWorkItems.values
                    .filter { $0.surfaceId == surfaceId }
                    .reduce(Int64(0)) {
                        SurfAceLocklessExactDurableAccounting.saturatingAdd($0, $1.bytes)
                    }
            )
            let prospective = SurfAceLocklessExactDurableAccounting.saturatingAdd(current, work.bytes)
            guard prospective <= state.limits.maxSurfaceRecoverableBaseBytes else {
                throw SurfAceLocklessRuntimeAdapterError.surfaceStateCapacity(
                    current: current,
                    prospective: prospective,
                    maximum: state.limits.maxSurfaceRecoverableBaseBytes
                )
            }
            state.targetApplyWorkItems[operationRequestId] = work
            return .object([
                "operationReceipt": .object([
                    "commitSequence": .integer(sequence),
                    "requestId": .string(operationRequestId),
                ]),
                "operationRequestId": .string(operationRequestId),
                "status": .string("intent_committed"),
                "surfaceId": .string(surfaceId),
                "targetEpoch": .integer(targetEpoch),
                "targetId": .string(targetId),
                "targetRequestId": .string(targetRequestId),
            ])
        }
    }

    nonisolated private static func validateAndNormalizeTargetIntent(
        _ request: SurfAceLocklessJSON,
        surface: SurfAceLocklessSurfaceMaterial
    ) throws -> SurfAceLocklessJSON {
        guard case .object(var payload) = request else {
            throw targetPrecommitFailure(message: "target.apply payload must be an object")
        }
        let pane: SurfAceLocklessPaneMaterial
        if case .integer(let paneId) = payload["paneId"],
           let currentPane = surface.panes[String(paneId)] {
            pane = currentPane
        } else if case .string(let paneLineageId) = payload["paneLineageId"],
                  let currentPane = surface.panes.values.first(where: {
                      $0.paneLineageId == paneLineageId
                  }) {
            pane = currentPane
        } else {
            throw targetPrecommitFailure(
                targetErrorCode: "pane_lineage_missing",
                message: "pane lineage is unknown"
            )
        }
        payload["paneId"] = .integer(pane.paneId)
        payload["paneLineageId"] = .string(pane.paneLineageId)

        guard case .string(let targetKind) = payload["targetKind"],
              targetKind == "browser_url" else {
            let targetKind: String
            if case .string(let value) = payload["targetKind"] {
                targetKind = value
            } else {
                targetKind = ""
            }
            throw SurfAceLocklessRuntimeAdapterError.targetPrecommit(
                code: "unsupported_operation",
                targetErrorCode: nil,
                message: "Unsupported target kind: \(targetKind)"
            )
        }
        guard case .object(let header) = payload["targetHeader"],
              case .array(let requiredCapabilityValues) = header["requiredCapabilities"],
              requiredCapabilityValues.allSatisfy({
                  if case .string = $0 { return true }
                  return false
              }) else {
            throw targetPrecommitFailure(
                targetErrorCode: "capability_missing",
                message: "required target capability is not advertised"
            )
        }
        let requiredCapabilities = requiredCapabilityValues.compactMap { value -> String? in
            guard case .string(let capability) = value else { return nil }
            return capability
        }
        guard requiredCapabilities.contains("target.browser_url.v1"),
              requiredCapabilities.allSatisfy(surfAceTargetCapabilities.contains),
              header["replaySemantics"] == .string("navigate") else {
            throw targetPrecommitFailure(
                targetErrorCode: "capability_missing",
                message: "required target capability is not advertised"
            )
        }
        guard !pane.annotationMode else {
            throw targetPrecommitFailure(
                targetErrorCode: "policy_denied",
                message: "annotation mode is active"
            )
        }
        guard case .object(let targetPayload) = payload["targetPayload"],
              case .string(let urlString) = targetPayload["url"],
              let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https" else {
            throw targetPrecommitFailure(
                targetErrorCode: "unsafe_payload",
                message: "browser_url targetPayload.url must be http or https"
            )
        }
        return .object(payload)
    }

    nonisolated private static func targetPrecommitFailure(
        targetErrorCode: String? = nil,
        message: String
    ) -> SurfAceLocklessRuntimeAdapterError {
        .targetPrecommit(
            code: "invalid_payload",
            targetErrorCode: targetErrorCode,
            message: message
        )
    }

    func materializeTargetWork(
        operationRequestId: String,
        materialize: @escaping @Sendable (SurfAceLocklessTargetWorkItem) async -> SurfAceLocklessMaterializationOutcome
    ) async throws -> SurfAceLocklessTargetResult {
        let work = try await coordinator.transact(trigger: "target_materialization_begin") { state in
            guard var work = state.targetApplyWorkItems[operationRequestId],
                  work.state == .intentCommitted else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            guard let surface = state.liveSurfaces[work.surfaceId]
                    ?? state.surfaceTombstones.first(where: { $0.surface.surfaceId == work.surfaceId })?.surface else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            let current = SurfAceLocklessExactDurableAccounting.saturatingAdd(
                try SurfAceLocklessTopologyOperations.surfaceBaseBytes(surface),
                state.targetApplyWorkItems.values
                    .filter { $0.surfaceId == work.surfaceId }
                    .reduce(Int64(0)) {
                        SurfAceLocklessExactDurableAccounting.saturatingAdd($0, $1.bytes)
                    }
            )
            let previousBytes = work.bytes
            work.state = .materializing
            work.bytes = try SurfAceLocklessExactDurableAccounting.targetWorkBytes(work)
            let prospective = SurfAceLocklessExactDurableAccounting.saturatingAdd(
                current - previousBytes,
                work.bytes
            )
            guard prospective <= state.limits.maxSurfaceRecoverableBaseBytes else {
                throw SurfAceLocklessRuntimeAdapterError.surfaceStateCapacity(
                    current: current,
                    prospective: prospective,
                    maximum: state.limits.maxSurfaceRecoverableBaseBytes
                )
            }
            state.targetApplyWorkItems[operationRequestId] = work
            return work
        }
        let outcome = await materialize(work)
        return try await finishTargetWork(work: work, outcome: outcome)
    }

    func recoverTargetWork(
        surfaceId: String? = nil,
        materialize: @escaping @Sendable (SurfAceLocklessTargetWorkItem) async -> SurfAceLocklessMaterializationOutcome
    ) async throws -> [SurfAceLocklessTargetResult] {
        let workItems = (await coordinator.snapshot()).targetApplyWorkItems.values.filter {
            surfaceId == nil || $0.surfaceId == surfaceId
        }.sorted {
            ($0.intentCommitSequence, $0.operationRequestId)
                < ($1.intentCommitSequence, $1.operationRequestId)
        }
        var results: [SurfAceLocklessTargetResult] = []
        for work in workItems {
            if work.state == .intentCommitted {
                results.append(try await materializeTargetWork(
                    operationRequestId: work.operationRequestId,
                    materialize: materialize
                ))
            } else {
                results.append(try await finishTargetWork(
                    work: work,
                    outcome: SurfAceLocklessMaterializationOutcome(
                        errorCode: "materialization_outcome_unknown",
                        materializedState: nil,
                        status: "failed"
                    )
                ))
            }
        }
        targetWorkRecovered = (await coordinator.snapshot()).targetApplyWorkItems.isEmpty
        return results
    }

    private func finishTargetWork(
        work: SurfAceLocklessTargetWorkItem,
        outcome: SurfAceLocklessMaterializationOutcome
    ) async throws -> SurfAceLocklessTargetResult {
        try await coordinator.transact(trigger: "target_materialization_finish") { state in
            guard state.targetApplyWorkItems[work.operationRequestId]?.state == .materializing else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            var result = SurfAceLocklessTargetResult(
                consumableSequence: 0,
                errorCode: outcome.errorCode,
                intentCommitSequence: work.intentCommitSequence,
                materializedState: outcome.materializedState,
                operationRequestId: work.operationRequestId,
                recordId: "target-result:\(work.intentCommitSequence)",
                status: outcome.status,
                surfaceId: work.surfaceId,
                targetEpoch: work.targetEpoch,
                targetId: work.targetId,
                targetRequestId: work.targetRequestId
            )
            if outcome.status == "applied",
               case .object(let request) = work.request,
               var surface = state.liveSurfaces[work.surfaceId] {
                let requestedPaneId: Int64? = {
                    guard case .integer(let value) = request["paneId"] else { return nil }
                    return value
                }()
                let requestedLineage: String? = {
                    guard case .string(let value) = request["paneLineageId"] else { return nil }
                    return value
                }()
                guard let paneKey = surface.panes.first(where: { key, pane in
                    (requestedPaneId.map { key == String($0) } ?? false)
                        || (requestedLineage.map { pane.paneLineageId == $0 } ?? false)
                })?.key,
                var pane = surface.panes[paneKey] else {
                    throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                }
                var evidence: [String: SurfAceLocklessJSON] = [
                    "intentCommitSequence": .integer(result.intentCommitSequence),
                    "operationRequestId": .string(result.operationRequestId),
                    "status": .string(result.status),
                    "targetEpoch": .integer(result.targetEpoch),
                    "targetId": .string(result.targetId),
                    "targetRequestId": .string(result.targetRequestId),
                ]
                evidence["materializedState"] = result.materializedState
                let restorePolicy: SurfAceLocklessJSON
                if case .string("initial_apply") = request["restoreReason"] {
                    restorePolicy = .string("confirm")
                } else {
                    restorePolicy = .string("auto")
                }
                pane.target = .object([
                    "currentState": .string("current"),
                    "lastApplyEvidence": .object(evidence),
                    "paneLineageId": .string(pane.paneLineageId),
                    "restorePolicy": restorePolicy,
                    "targetEpoch": .integer(work.targetEpoch),
                    "targetHeader": request["targetHeader"] ?? .object([:]),
                    "targetId": .string(work.targetId),
                    "targetKind": request["targetKind"] ?? .null,
                    "targetPayload": request["targetPayload"] ?? .null,
                ])
                if case .string("browser_url") = request["targetKind"],
                   case .object(let targetPayload) = request["targetPayload"],
                   case .string(let url) = targetPayload["url"],
                   let targetEpoch = Int(exactly: work.targetEpoch) {
                    let title: String? = {
                        guard case .object(let display) = request["display"],
                              case .string(let value) = display["title"] else { return nil }
                        return value
                    }()
                    let allowedSnapshotFallback: Bool? = {
                        guard case .bool(let value) = targetPayload["allowedSnapshotFallback"] else { return nil }
                        return value
                    }()
                    let fallbackSnapshotTargetId: String? = {
                        guard case .string(let value) = targetPayload["fallbackSnapshotTargetId"] else { return nil }
                        return value
                    }()
                    let legacyEntry = SurfAcePaneEntry.browserURL(
                        targetId: work.targetId,
                        targetEpoch: targetEpoch,
                        url: url,
                        title: title,
                        allowedSnapshotFallback: allowedSnapshotFallback,
                        fallbackSnapshotTargetId: fallbackSnapshotTargetId
                    )
                    guard case .object(var content) = try Self.locklessJSON(legacyEntry) else {
                        throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
                    }
                    for field in ["contentId", "contentType", "drawingData", "revision", "strokesById"] {
                        content.removeValue(forKey: field)
                    }
                    let empty: SurfAceLocklessJSON = .object([
                        "interactive": .bool(true), "scrollable": .bool(true),
                    ])
                    if pane.history.visible.contentId != nil
                        || pane.history.visible.contentType != nil
                        || pane.history.visible.content != empty {
                        pane.history.back.append(pane.history.visible)
                    }
                    pane.history.forward.removeAll()
                    while pane.history.back.count + pane.history.forward.count > 20 {
                        pane.history.back.removeFirst()
                    }
                    let revision = pane.history.nextRevision
                    pane.history.nextRevision += 1
                    let visibleSequence = pane.history.nextVisibleSequence
                    pane.history.nextVisibleSequence += 1
                    pane.history.visible = SurfAceLocklessHistoryEntry(
                        annotations: .object(["drawingData": .string(""), "strokesById": .object([:])]),
                        content: .object(content),
                        contentId: nil,
                        contentType: nil,
                        historyEntryId: "he_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased())",
                        lastVisibleSequence: visibleSequence,
                        provenance: .init(
                            friendlyChatName: nil,
                            controllerProductName: state.controllers[work.controllerInstanceId]?.controllerProductName
                        ),
                        revision: revision
                    )
                }
                surface.panes[paneKey] = pane
                surface.surfaceRevision += 1
                state.liveSurfaces[work.surfaceId] = surface
            }
            state.targetApplyWorkItems.removeValue(forKey: work.operationRequestId)
            var recordPayload: [String: SurfAceLocklessJSON] = [
                "intentCommitSequence": .integer(result.intentCommitSequence),
                "operationRequestId": .string(result.operationRequestId),
                "status": .string(result.status),
                "surfaceId": .string(result.surfaceId),
                "targetEpoch": .integer(result.targetEpoch),
                "targetId": .string(result.targetId),
                "targetRequestId": .string(result.targetRequestId),
            ]
            recordPayload["errorCode"] = result.errorCode.map(SurfAceLocklessJSON.string)
            recordPayload["materializedState"] = result.materializedState
            let occurrence = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
                in: &state,
                scopeId: Self.surfaceScopeId(result.surfaceId),
                scopeKind: "surface",
                recordId: result.recordId,
                recordClass: .targetResult,
                payload: .object(recordPayload)
            )
            result.consumableSequence = occurrence.record.sequence
            state.targetApplyResults[work.operationRequestId] = result
            return result
        }
    }

    func fanout(afterCommitted event: SurfAceLocklessJSON) -> SurfAceLocklessFanout {
        SurfAceLocklessFanout(
            connectionTokens: controllerByConnection.keys.sorted(),
            event: event
        )
    }

    func pendingControllerRetentionReclamations() async -> [SurfAceLocklessControllerRetentionDelivery] {
        let state = await coordinator.snapshot()
        return (state.pendingControllerRetentionReclamations ?? []).sorted {
            $0.commitSequence < $1.commitSequence
        }.map { record in
            let delivered = Set(record.deliveredControllerInstanceIds)
            let recipients = Set(record.recipientControllerInstanceIds).subtracting(delivered)
            let connections = Dictionary(uniqueKeysWithValues: recipients.compactMap { controllerId in
                connectionByController[controllerId].map { (controllerId, $0) }
            })
            return SurfAceLocklessControllerRetentionDelivery(
                connectionTokensByControllerInstanceId: connections,
                record: record
            )
        }
    }

    func acknowledgeControllerRetentionReclamation(
        eventId: String,
        deliveredControllerInstanceIds: [String]
    ) async throws {
        try await coordinator.transact(trigger: "controller_reclamation_delivery_ack") { state in
            var pending = state.pendingControllerRetentionReclamations ?? []
            guard let index = pending.firstIndex(where: { $0.eventId == eventId }) else { return }
            var delivered = Set(pending[index].deliveredControllerInstanceIds)
            delivered.formUnion(deliveredControllerInstanceIds)
            let recipients = Set(pending[index].recipientControllerInstanceIds)
            if recipients.isSubset(of: delivered) {
                pending.remove(at: index)
            } else {
                pending[index].deliveredControllerInstanceIds = delivered.sorted()
            }
            state.pendingControllerRetentionReclamations = pending
        }
    }

    func snapshot() async -> SurfAceLocklessAuthorityState {
        await coordinator.snapshot()
    }

    func readinessSnapshot() async -> SurfAceLocklessReadinessSnapshot {
        let state = await coordinator.snapshot()
        return SurfAceLocklessReadinessSnapshot(
            fullGenerationLoaded: true,
            readyForAdmission: SurfAceLocklessTargetAdmission.platformPermitsLockless
                && SurfAceLocklessTargetAdmission.implementationComplete
                && targetWorkRecovered,
            state: state,
            targetWorkRecovered: targetWorkRecovered
        )
    }

    nonisolated private static func encodedBytes(_ value: SurfAceLocklessJSON) throws -> Int {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try encoder.encode(value).count
    }

    nonisolated private static func ensureScopes(
        surfaceId: String,
        in state: inout SurfAceLocklessAuthorityState
    ) throws {
        try SurfAceLocklessConsumableOperations.ensureScope(
            in: &state, scopeId: surfaceScopeId(surfaceId), scopeKind: "surface"
        )
        guard let surface = state.liveSurfaces[surfaceId] else { return }
        for pane in surface.panes.values {
            try SurfAceLocklessConsumableOperations.ensureScope(
                in: &state,
                scopeId: paneScopeId(surfaceId: surfaceId, paneId: pane.paneId),
                scopeKind: "pane"
            )
        }
    }

    nonisolated private static func receiptResolutions(
        bundle: SurfAceLocklessControllerBundle?,
        controllerWasKnown: Bool,
        requestIds: [String]
    ) -> [SurfAceLocklessJSON] {
        requestIds.map { requestId in
            guard controllerWasKnown else {
                return .object([
                    "cause": .string("controller_reclaimed"),
                    "outcome": .string("receipt_unavailable"),
                    "requestId": .string(requestId),
                ])
            }
            guard let receipt = bundle?.pendingOperationReceipts[requestId] else {
                return .object(["outcome": .string("not_committed"), "requestId": .string(requestId)])
            }
            if receipt.status == .pending {
                return .object(["outcome": .string("still_pending"), "requestId": .string(requestId)])
            }
            return .object([
                "operationReceipt": .object([
                    "commitSequence": .integer(receipt.commitSequence ?? 0),
                    "requestId": .string(requestId),
                ]),
                "outcome": .string(receipt.outcome ?? "resolved_failure"),
                "requestId": .string(requestId),
                "terminalResponse": receipt.terminalResponse ?? .null,
            ])
        }
    }

    nonisolated private static func locklessJSON<T: Encodable>(
        _ value: T
    ) throws -> SurfAceLocklessJSON {
        try JSONDecoder().decode(SurfAceLocklessJSON.self, from: JSONEncoder().encode(value))
    }

    nonisolated private static func surfaceScopeId(_ surfaceId: String) -> String {
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        let encoded = surfaceId.addingPercentEncoding(withAllowedCharacters: unreserved) ?? surfaceId
        return "surface:\(encoded)"
    }

    nonisolated private static func paneScopeId(surfaceId: String, paneId: Int64) -> String {
        "pane:\(surfaceScopeId(surfaceId).dropFirst("surface:".count)):\(paneId)"
    }

    nonisolated private static func committedFailureResponse(
        error: Error,
        operation: String,
        requestId: String,
        commitSequence: Int64
    ) -> SurfAceLocklessJSON? {
        let code: String
        let details: SurfAceLocklessJSON?
        if let error = error as? SurfAceLocklessTopologyOperationError {
            switch error {
            case .surfaceStateCapacity:
                return nil
            case .staleTopology(let currentRevision, let currentTopology):
                code = "stale_topology"
                details = .object([
                    "currentRevision": .integer(currentRevision),
                    "currentTopology": currentTopology,
                ])
            case .staleSurfaceSet(let currentRevision):
                code = "stale_surface_set"
                details = .object(["currentRevision": .integer(currentRevision)])
            case .paneCapacity(let current, let requested, let maximum):
                code = "pane_capacity"
                details = .object([
                    "current": .integer(current),
                    "maximum": .integer(maximum),
                    "requested": .integer(requested),
                ])
            case .paneStateCapacity(let limit, let current, let prospective, let maximum):
                code = "pane_state_capacity"
                details = .object([
                    "currentBytes": .integer(current),
                    "limit": .string(limit),
                    "maximumBytes": .integer(maximum),
                    "prospectiveBytes": .integer(prospective),
                ])
            case .tombstoneCapacity(let bytes, let maximum):
                code = "tombstone_capacity"
                details = .object(["bytes": .integer(bytes), "maximumBytes": .integer(maximum)])
            case .tombstoneNotFound(let id):
                code = "tombstone_not_found"
                details = .object(["tombstoneId": .string(id)])
            default:
                code = "invalid_payload"
                details = nil
            }
        } else if let error = error as? SurfAceLocklessContentOperationError {
            switch error {
            case .staleContent(let contentId, let revision):
                code = "stale_content"
                details = .object([
                    "currentContentId": contentId.map(SurfAceLocklessJSON.string) ?? .null,
                    "currentRevision": .integer(revision),
                ])
            case .paneStateCapacity(let limit, let current, let prospective, let maximum):
                code = "pane_state_capacity"
                details = .object([
                    "currentBytes": .integer(current),
                    "limit": .string(limit),
                    "maximumBytes": .integer(maximum),
                    "prospectiveBytes": .integer(prospective),
                ])
            default:
                code = "invalid_payload"
                details = nil
            }
        } else if let error = error as? SurfAceLocklessRuntimeAdapterError {
            switch error {
            case .surfaceStateCapacity, .targetPrecommit:
                return nil
            default:
                break
            }
            code = "invalid_payload"
            details = nil
        } else if error is SurfAceLocklessAuthorityError {
            code = "internal_error"
            details = nil
        } else {
            code = "internal_error"
            details = nil
        }
        var errorObject: [String: SurfAceLocklessJSON] = [
            "code": .string(code),
            "message": .string(code),
        ]
        errorObject["details"] = details
        return .object([
            "error": .object(errorObject),
            "id": .string(requestId),
            "ok": .bool(false),
            "op": .string(operation),
            "sentAt": .integer(Int64(Date().timeIntervalSince1970 * 1_000)),
            "type": .string("response"),
            "v": .integer(1),
        ])
    }

    nonisolated private static func successResponse(
        operation: String,
        requestId: String,
        payload: SurfAceLocklessJSON
    ) -> SurfAceLocklessJSON {
        .object([
            "id": .string(requestId),
            "ok": .bool(true),
            "op": .string(operation),
            "payload": payload,
            "sentAt": .integer(Int64(Date().timeIntervalSince1970 * 1_000)),
            "type": .string("response"),
            "v": .integer(1),
        ])
    }

    nonisolated private static func exactReceipt(
        commitSequence: Int64,
        operation: String,
        outcome: String = "resolved_success",
        requestId: String,
        terminalResponse: SurfAceLocklessJSON
    ) throws -> SurfAceLocklessOperationReceiptState {
        var receipt = SurfAceLocklessOperationReceiptState(
            bytes: 0,
            commitSequence: commitSequence,
            operation: operation,
            outcome: outcome,
            requestId: requestId,
            status: .terminal,
            terminalResponse: terminalResponse
        )
        receipt.bytes = try SurfAceLocklessExactDurableAccounting.receiptBytes(receipt)
        return receipt
    }

    nonisolated private static func normalizeTopologies(
        in state: inout SurfAceLocklessAuthorityState
    ) throws {
        for surfaceId in state.liveSurfaces.keys {
            guard var surface = state.liveSurfaces[surfaceId] else { continue }
            surface.topology = try SurfAceLocklessTopologyCodec.canonical(surface.topology)
            state.liveSurfaces[surfaceId] = surface
        }
        for index in state.surfaceTombstones.indices {
            var tombstone = state.surfaceTombstones[index]
            tombstone.surface.topology = try SurfAceLocklessTopologyCodec.canonical(tombstone.surface.topology)
            state.surfaceTombstones[index] = tombstone
        }
    }
}
