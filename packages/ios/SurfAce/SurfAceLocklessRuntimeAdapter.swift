import Foundation

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
    case controllerCapacity
    case duplicateLiveController
    case invalidAdmission
    case notPaired
    case receiptCapacity
    case receiptUnavailable
    case stillPending
}

struct SurfAceLocklessAdmissionResult: Equatable, Sendable {
    var controllerInstanceId: String
    var limits: SurfAceLocklessCapacityLimits
    var resumed: Bool
    var state: SurfAceLocklessAuthorityState
}

struct SurfAceLocklessCommittedMutation: Equatable, Sendable {
    var commitSequence: Int64
    var requestId: String
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
    private var connectionByController: [String: String] = [:]
    private var controllerByConnection: [String: String] = [:]
    private var targetWorkRecovered: Bool

    init(store: SurfAceLocklessGenerationStore, legacy: SurfAceLegacyUserDefaultsSnapshot) throws {
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
        if restoredLiveController || loadedState == nil {
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
        protocolFeatures: [String]
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

        let resumed = try await coordinator.transact { state in
            if state.controllers[controllerInstanceId]?.status == .live {
                throw SurfAceLocklessRuntimeAdapterError.duplicateLiveController
            }
            let resumed = state.controllers[controllerInstanceId] != nil
            if !resumed && Int64(state.controllers.count) >= state.limits.maxAdmittedControllerEntries {
                let victim = state.controllers.values
                    .filter { $0.status == .dormant }
                    .sorted {
                        ($0.dormantSequence ?? .max, $0.controllerInstanceId)
                            < ($1.dormantSequence ?? .max, $1.controllerInstanceId)
                    }
                    .first
                guard let victim else { throw SurfAceLocklessRuntimeAdapterError.controllerCapacity }
                state.controllers.removeValue(forKey: victim.controllerInstanceId)
                for scopeId in state.scopes.keys {
                    state.scopes[scopeId]?.cursors.removeValue(forKey: victim.controllerInstanceId)
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
            SurfAceLocklessConsumableOperations.admitController(controllerInstanceId, in: &state)
            return resumed
        }
        connectionByController[controllerInstanceId] = connectionToken
        controllerByConnection[connectionToken] = controllerInstanceId
        return SurfAceLocklessAdmissionResult(
            controllerInstanceId: controllerInstanceId,
            limits: (await coordinator.snapshot()).limits,
            resumed: resumed,
            state: await coordinator.snapshot()
        )
    }

    func disconnect(connectionToken: String, disconnectedAt: Int64) async throws {
        guard let controllerId = controllerByConnection[connectionToken] else { return }
        try await coordinator.transact { state in
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
        return try await coordinator.transact { state in
            guard var bundle = state.controllers[controllerId], bundle.status == .live else {
                throw SurfAceLocklessRuntimeAdapterError.notPaired
            }
            guard bundle.pendingOperationReceipts[requestId] == nil else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            let pending = bundle.pendingOperationReceipts.values.filter { $0.status != .acknowledged }
            guard Int64(pending.count) < state.limits.maxPendingOperationReceiptsPerController else {
                throw SurfAceLocklessRuntimeAdapterError.receiptCapacity
            }
            let commitSequence = state.sequences.nextCommitSequence
            let response = try mutate(&state, commitSequence)
            if let consumableScopeId, let consumableScopeKind, let consumableRecordClass {
                let recordPayload = try consumablePayload?(state, response) ?? response
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
            let receipt = try Self.exactReceipt(
                commitSequence: commitSequence,
                operation: operation,
                requestId: requestId,
                terminalResponse: response
            )
            guard pending.reduce(Int64(0), { $0 + $1.bytes }) + receipt.bytes
                    <= state.limits.maxPendingOperationReceiptBytesPerController else {
                throw SurfAceLocklessRuntimeAdapterError.receiptCapacity
            }
            state.sequences.nextCommitSequence += 1
            bundle.pendingOperationReceipts[requestId] = receipt
            state.controllers[controllerId] = bundle
            return SurfAceLocklessCommittedMutation(
                commitSequence: commitSequence,
                requestId: requestId,
                terminalResponse: response
            )
        }
    }

    func commitLocalMutation(
        operation: String,
        mutate: @escaping Mutation
    ) async throws -> SurfAceLocklessLocalCommit {
        try await coordinator.transact { state in
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
        try await coordinator.transact { state in
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
        try await coordinator.transact { state in
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
        return try await commitMutation(
            connectionToken: connectionToken,
            requestId: operationRequestId,
            operation: "target.apply"
        ) { state, sequence in
            let work = SurfAceLocklessTargetWorkItem(
                bytes: Int64(try Self.encodedBytes(request)),
                controllerInstanceId: controllerId,
                intentCommitSequence: sequence,
                operationRequestId: operationRequestId,
                request: request,
                state: .intentCommitted,
                surfaceId: surfaceId,
                targetEpoch: targetEpoch,
                targetId: targetId,
                targetRequestId: targetRequestId
            )
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

    func materializeTargetWork(
        operationRequestId: String,
        materialize: @escaping @Sendable (SurfAceLocklessTargetWorkItem) async -> SurfAceLocklessMaterializationOutcome
    ) async throws -> SurfAceLocklessTargetResult {
        let work = try await coordinator.transact { state in
            guard var work = state.targetApplyWorkItems[operationRequestId],
                  work.state == .intentCommitted else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            work.state = .materializing
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
        try await coordinator.transact { state in
            guard state.targetApplyWorkItems[work.operationRequestId]?.state == .materializing else {
                throw SurfAceLocklessRuntimeAdapterError.invalidAdmission
            }
            let result = SurfAceLocklessTargetResult(
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
            state.targetApplyResults[work.operationRequestId] = result
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
            _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
                in: &state,
                scopeId: Self.surfaceScopeId(result.surfaceId),
                scopeKind: "surface",
                recordId: result.recordId,
                recordClass: .targetResult,
                payload: .object(recordPayload)
            )
            return result
        }
    }

    func fanout(afterCommitted event: SurfAceLocklessJSON) -> SurfAceLocklessFanout {
        SurfAceLocklessFanout(
            connectionTokens: controllerByConnection.keys.sorted(),
            event: event
        )
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

    nonisolated private static func exactReceipt(
        commitSequence: Int64,
        operation: String,
        requestId: String,
        terminalResponse: SurfAceLocklessJSON
    ) throws -> SurfAceLocklessOperationReceiptState {
        var receipt = SurfAceLocklessOperationReceiptState(
            bytes: 0,
            commitSequence: commitSequence,
            operation: operation,
            outcome: "resolved_success",
            requestId: requestId,
            status: .terminal,
            terminalResponse: terminalResponse
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        while true {
            let bytes = Int64(try encoder.encode(receipt).count)
            guard bytes != receipt.bytes else { return receipt }
            receipt.bytes = bytes
        }
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
