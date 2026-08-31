import Foundation

let surfAceLocklessCapability = "surf-ace.lockless-multi-controller.v1"

enum SurfAceLocklessJSON: Codable, Equatable, Sendable {
    case array([SurfAceLocklessJSON])
    case bool(Bool)
    case double(Double)
    case integer(Int64)
    case null
    case object([String: SurfAceLocklessJSON])
    case string(String)

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int64.self) {
            self = .integer(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([SurfAceLocklessJSON].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: SurfAceLocklessJSON].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .array(let value): try container.encode(value)
        case .bool(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .integer(let value): try container.encode(value)
        case .null: try container.encodeNil()
        case .object(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        }
    }
}

struct SurfAceLocklessCapacityLimits: Codable, Equatable, Sendable {
    var version: Int
    var maxPanesPerSurface: Int64
    var maxSurfaceRecoverableBaseBytes: Int64
    var maxPaneRecoverableStateBytes: Int64
    var maxPaneAnnotationRestoreBytes: Int64
    var maxRetainedTombstones: Int64
    var maxRetainedTombstoneBytes: Int64
    var maxRecoverableSurfaceBytes: Int64
    var maxPaneConsumableRecords: Int64
    var maxPaneConsumableBytes: Int64
    var maxSurfaceConsumableRecords: Int64
    var maxSurfaceConsumableBytes: Int64
    var maxConsumableRecordBytes: Int64
    var maxConsumableCursorStateBytesPerScope: Int64
    var maxAdmittedControllerEntries: Int64
    var maxDormantControllerEntries: Int64
    var maxDormantControllerBytes: Int64
    var maxPendingOperationReceiptsPerController: Int64
    var maxPendingOperationReceiptBytesPerController: Int64

    static let production = SurfAceLocklessCapacityLimits(
        version: 1,
        maxPanesPerSurface: 16,
        maxSurfaceRecoverableBaseBytes: 1 * 1_024 * 1_024,
        maxPaneRecoverableStateBytes: 8 * 1_024 * 1_024,
        maxPaneAnnotationRestoreBytes: 4 * 1_024 * 1_024,
        maxRetainedTombstones: 32,
        maxRetainedTombstoneBytes: 1_024 * 1_024 * 1_024,
        maxRecoverableSurfaceBytes: 640 * 1_024 * 1_024,
        maxPaneConsumableRecords: 256,
        maxPaneConsumableBytes: 4 * 1_024 * 1_024,
        maxSurfaceConsumableRecords: 1_024,
        maxSurfaceConsumableBytes: 4 * 1_024 * 1_024,
        maxConsumableRecordBytes: 1 * 1_024 * 1_024,
        maxConsumableCursorStateBytesPerScope: 4_096,
        maxAdmittedControllerEntries: 16,
        maxDormantControllerEntries: 12,
        maxDormantControllerBytes: 64 * 1_024 * 1_024,
        maxPendingOperationReceiptsPerController: 128,
        maxPendingOperationReceiptBytesPerController: 8 * 1_024 * 1_024
    )

    var recoverableSurfaceMinimumBytes: Int64 {
        let paneEnvelope = maxPaneRecoverableStateBytes
            + maxPaneConsumableBytes
            + maxAdmittedControllerEntries * maxConsumableCursorStateBytesPerScope
        return maxSurfaceRecoverableBaseBytes
            + maxSurfaceConsumableBytes
            + maxAdmittedControllerEntries * maxConsumableCursorStateBytesPerScope
            + (maxPanesPerSurface + maxRetainedTombstones) * paneEnvelope
    }

    func validate() throws {
        guard version == 1 else { throw SurfAceLocklessAuthorityError.unsupportedVersion }
        let fields: [(String, Int64)] = [
            ("maxPanesPerSurface", maxPanesPerSurface),
            ("maxSurfaceRecoverableBaseBytes", maxSurfaceRecoverableBaseBytes),
            ("maxPaneRecoverableStateBytes", maxPaneRecoverableStateBytes),
            ("maxPaneAnnotationRestoreBytes", maxPaneAnnotationRestoreBytes),
            ("maxRetainedTombstones", maxRetainedTombstones),
            ("maxRetainedTombstoneBytes", maxRetainedTombstoneBytes),
            ("maxRecoverableSurfaceBytes", maxRecoverableSurfaceBytes),
            ("maxPaneConsumableRecords", maxPaneConsumableRecords),
            ("maxPaneConsumableBytes", maxPaneConsumableBytes),
            ("maxSurfaceConsumableRecords", maxSurfaceConsumableRecords),
            ("maxSurfaceConsumableBytes", maxSurfaceConsumableBytes),
            ("maxConsumableRecordBytes", maxConsumableRecordBytes),
            ("maxConsumableCursorStateBytesPerScope", maxConsumableCursorStateBytesPerScope),
            ("maxAdmittedControllerEntries", maxAdmittedControllerEntries),
            ("maxDormantControllerEntries", maxDormantControllerEntries),
            ("maxDormantControllerBytes", maxDormantControllerBytes),
            ("maxPendingOperationReceiptsPerController", maxPendingOperationReceiptsPerController),
            ("maxPendingOperationReceiptBytesPerController", maxPendingOperationReceiptBytesPerController),
        ]
        if let field = fields.first(where: { $0.1 <= 0 })?.0 {
            throw SurfAceLocklessAuthorityError.invalidLimit(field)
        }
        guard maxPaneAnnotationRestoreBytes <= maxPaneRecoverableStateBytes else {
            throw SurfAceLocklessAuthorityError.invalidLimit("annotation_exceeds_pane")
        }
        guard maxRecoverableSurfaceBytes <= maxRetainedTombstoneBytes else {
            throw SurfAceLocklessAuthorityError.invalidLimit("surface_exceeds_tombstone_pool")
        }
        guard maxRecoverableSurfaceBytes >= recoverableSurfaceMinimumBytes else {
            throw SurfAceLocklessAuthorityError.invalidLimit("recoverable_surface_envelope")
        }
    }
}

struct SurfAceLocklessEntryProvenance: Codable, Equatable, Sendable {
    var friendlyChatName: String?
    var controllerProductName: String?
}

struct SurfAceLocklessHistoryEntry: Codable, Equatable, Sendable {
    var annotations: SurfAceLocklessJSON
    var content: SurfAceLocklessJSON
    var contentId: String?
    var contentType: String?
    var historyEntryId: String
    var lastVisibleSequence: Int64
    var provenance: SurfAceLocklessEntryProvenance
    var revision: Int64
}

struct SurfAceLocklessHistory: Codable, Equatable, Sendable {
    var back: [SurfAceLocklessHistoryEntry]
    var forward: [SurfAceLocklessHistoryEntry]
    var nextRevision: Int64
    var nextVisibleSequence: Int64
    var visible: SurfAceLocklessHistoryEntry
}

struct SurfAceLocklessPaneMaterial: Codable, Equatable, Sendable {
    var annotationMode: Bool
    var history: SurfAceLocklessHistory
    var name: String?
    var paneId: Int64
    var paneLabel: Int64
    var paneLineageId: String
    var target: SurfAceLocklessJSON?
}

struct SurfAceLocklessPaneTombstone: Codable, Equatable, Sendable {
    var bytes: Int64
    var closedSequence: Int64
    var pane: SurfAceLocklessPaneMaterial
    var scope: SurfAceLocklessConsumableScope
    var tombstoneId: String
}

struct SurfAceLocklessSurfaceMaterial: Codable, Equatable, Sendable {
    var name: String
    var nativeRestoreMaterial: SurfAceLocklessJSON
    var nextPaneId: Int64
    var nextPaneLabel: Int64
    var paneTombstones: [SurfAceLocklessPaneTombstone]
    var panes: [String: SurfAceLocklessPaneMaterial]
    var sceneKeys: [String]
    var surfaceId: String
    var surfaceRevision: Int64
    var topology: SurfAceLocklessJSON
    var topologyRevision: Int64
    var windowLabel: String
}

struct SurfAceLocklessSurfaceTombstone: Codable, Equatable, Sendable {
    var bytes: Int64
    var closedSequence: Int64
    var scopes: [String: SurfAceLocklessConsumableScope]
    var surface: SurfAceLocklessSurfaceMaterial
    var tombstoneId: String
}

enum SurfAceLocklessControllerStatus: String, Codable, Equatable, Sendable {
    case dormant
    case live
}

enum SurfAceLocklessReceiptStatus: String, Codable, Equatable, Sendable {
    case acknowledged
    case pending
    case terminal
}

struct SurfAceLocklessOperationReceiptState: Codable, Equatable, Sendable {
    var bytes: Int64
    var commitSequence: Int64?
    var operation: String
    var outcome: String?
    var requestId: String
    var status: SurfAceLocklessReceiptStatus
    var terminalResponse: SurfAceLocklessJSON?
}

struct SurfAceLocklessControllerBundle: Codable, Equatable, Sendable {
    var controllerInstanceId: String
    var controllerProductName: String?
    var disconnectedAt: Int64?
    var dormantSequence: Int64?
    var pendingOperationReceipts: [String: SurfAceLocklessOperationReceiptState]
    var projectionCapacityBytes: Int64
    var status: SurfAceLocklessControllerStatus
}

struct SurfAceLocklessControllerRetentionReclamation: Codable, Equatable, Sendable {
    var commitSequence: Int64
    var controllerInstanceId: String
    var cursorBytes: Int64
    var cursorCount: Int64
    var disconnectedAt: Int64?
    var deliveredControllerInstanceIds: [String]
    var dormantSequence: Int64
    var eventId: String
    var liveCursorBytes: Int64
    var liveCursorCount: Int64
    var maxAdmittedControllerEntries: Int64
    var maxDormantControllerBytes: Int64
    var maxDormantControllerEntries: Int64
    var reason: String
    var recipientControllerInstanceIds: [String]
    var receiptBytes: Int64
    var receiptCount: Int64
    var registryBytes: Int64
    var scopeCount: Int64
    var surfaceCount: Int64
    var surfaceCursorBytes: Int64
    var surfaceCursorCount: Int64
    var tombstoneCount: Int64
    var tombstoneCursorBytes: Int64
    var tombstoneCursorCount: Int64
    var trigger: String
    var unreadBytes: Int64
    var unreadBytesDiscarded: Int64
    var unreadFrameCount: Int64
    var unreadFrameCountDiscarded: Int64
    var unreadRecordCount: Int64
    var unreadRecordCountDiscarded: Int64
}

enum SurfAceLocklessConsumableRecordClass: String, Codable, Equatable, Sendable {
    case annotationFrame = "annotation_frame"
    case content
    case history
    case navigation
    case page
    case playback
    case scroll
    case selection
    case tap
    case targetResult = "target_result"
    case topology
}

struct SurfAceLocklessConsumableRecord: Codable, Equatable, Sendable {
    var bytes: Int64
    var payload: SurfAceLocklessJSON
    var recordClass: SurfAceLocklessConsumableRecordClass
    var recordId: String
    var sequence: Int64
}

struct SurfAceLocklessConsumableGap: Codable, Equatable, Sendable {
    var cause: String
    var droppedBytes: Int64?
    var droppedEventCount: Int64?
    var droppedFrameCount: Int64?
    var droppedRecordCount: Int64?
    var firstLostSequence: Int64?
    var generation: Int64
    var lastLostSequence: Int64?
    var lossExtent: String
    var recordClasses: [SurfAceLocklessConsumableRecordClass]
}

struct SurfAceLocklessConsumableCursor: Codable, Equatable, Sendable {
    var cursor: Int64
    var gap: SurfAceLocklessConsumableGap?
    var gapGeneration: Int64
}

struct SurfAceLocklessConsumableScope: Codable, Equatable, Sendable {
    var cursors: [String: SurfAceLocklessConsumableCursor]
    var liveFrames: [String: SurfAceLocklessConsumableRecord]
    var nextSequence: Int64
    var records: [SurfAceLocklessConsumableRecord]
    var scopeId: String
    var scopeKind: String
}

enum SurfAceLocklessTargetWorkState: String, Codable, Equatable, Sendable {
    case intentCommitted = "intent_committed"
    case materializing
}

struct SurfAceLocklessTargetOperationIdentity: Codable, Equatable, Hashable, Sendable {
    var controllerInstanceId: String
    var operationRequestId: String

    var storageKey: String {
        "\(controllerInstanceId.utf8.count):\(controllerInstanceId)\(operationRequestId)"
    }
}

struct SurfAceLocklessTargetWorkItem: Codable, Equatable, Sendable {
    var bytes: Int64
    var controllerInstanceId: String
    var intentCommitSequence: Int64
    var operationRequestId: String
    var request: SurfAceLocklessJSON
    var state: SurfAceLocklessTargetWorkState
    var surfaceId: String
    var targetEpoch: Int64
    var targetId: String
    var targetRequestId: String

    var identity: SurfAceLocklessTargetOperationIdentity {
        SurfAceLocklessTargetOperationIdentity(
            controllerInstanceId: controllerInstanceId,
            operationRequestId: operationRequestId
        )
    }
}

struct SurfAceLocklessTargetResult: Codable, Equatable, Sendable {
    var consumableSequence: Int64
    var controllerInstanceId: String
    var errorCode: String?
    var intentCommitSequence: Int64
    var materializedState: SurfAceLocklessJSON?
    var operationRequestId: String
    var recordId: String
    var status: String
    var surfaceId: String
    var targetEpoch: Int64
    var targetId: String
    var targetRequestId: String

    var identity: SurfAceLocklessTargetOperationIdentity {
        SurfAceLocklessTargetOperationIdentity(
            controllerInstanceId: controllerInstanceId,
            operationRequestId: operationRequestId
        )
    }
}

struct SurfAceLocklessClientSequences: Codable, Equatable, Sendable {
    var nextClosedSequence: Int64
    var nextCommitSequence: Int64
    var nextDormantSequence: Int64
    var nextSurfaceId: Int64
    var nextSurfaceLabel: Int64
}

struct SurfAceLocklessAuthorityState: Codable, Equatable, Sendable {
    var capability: String
    var controllers: [String: SurfAceLocklessControllerBundle]
    var generation: Int64
    var limits: SurfAceLocklessCapacityLimits
    var liveSurfaces: [String: SurfAceLocklessSurfaceMaterial]
    var pendingControllerRetentionReclamations: [SurfAceLocklessControllerRetentionReclamation]?
    var pendingTombstoneReclamations: [SurfAceLocklessTombstoneReclamation]?
    var sceneSurfaceIds: [String: String]
    var scopes: [String: SurfAceLocklessConsumableScope]
    var sequences: SurfAceLocklessClientSequences
    var surfaceSetRevision: Int64
    var surfaceTombstones: [SurfAceLocklessSurfaceTombstone]
    var targetApplyResults: [String: SurfAceLocklessTargetResult]
    var targetApplyWorkItems: [String: SurfAceLocklessTargetWorkItem]
    var version: Int

    static func empty(limits: SurfAceLocklessCapacityLimits = .production) throws -> Self {
        try limits.validate()
        return SurfAceLocklessAuthorityState(
            capability: surfAceLocklessCapability,
            controllers: [:],
            generation: 0,
            limits: limits,
            liveSurfaces: [:],
            pendingControllerRetentionReclamations: [],
            pendingTombstoneReclamations: [],
            sceneSurfaceIds: [:],
            scopes: [:],
            sequences: SurfAceLocklessClientSequences(
                nextClosedSequence: 1,
                nextCommitSequence: 1,
                nextDormantSequence: 1,
                nextSurfaceId: 1,
                nextSurfaceLabel: 1
            ),
            surfaceSetRevision: 0,
            surfaceTombstones: [],
            targetApplyResults: [:],
            targetApplyWorkItems: [:],
            version: 1
        )
    }

    func validate() throws {
        guard version == 1, capability == surfAceLocklessCapability, generation >= 0 else {
            throw SurfAceLocklessAuthorityError.unsupportedVersion
        }
        try limits.validate()
        let allSequences = [
            sequences.nextClosedSequence,
            sequences.nextCommitSequence,
            sequences.nextDormantSequence,
            sequences.nextSurfaceId,
            sequences.nextSurfaceLabel,
        ]
        guard allSequences.allSatisfy({ $0 > 0 }), surfaceSetRevision >= 0 else {
            throw SurfAceLocklessAuthorityError.invalidState("client_sequences")
        }
        try SurfAceLocklessTopologyOperations.validateRestoredRecoverableState(self)
        let tombstonedSurfaceIds = Set(surfaceTombstones.map(\.surface.surfaceId))
        guard tombstonedSurfaceIds.count == surfaceTombstones.count,
              tombstonedSurfaceIds.isDisjoint(with: liveSurfaces.keys) else {
            throw SurfAceLocklessAuthorityError.invalidState("surface_lifecycle_identity")
        }
        guard Int64(controllers.count) <= limits.maxAdmittedControllerEntries else {
            throw SurfAceLocklessAuthorityError.invalidState("admitted_controller_entries")
        }
        let pendingReclamations = pendingControllerRetentionReclamations ?? []
        guard Set(pendingReclamations.map(\.eventId)).count == pendingReclamations.count,
              Set(pendingReclamations.map(\.commitSequence)).count == pendingReclamations.count else {
            throw SurfAceLocklessAuthorityError.invalidState("controller_retention_reclamation_outbox")
        }
        for reclamation in pendingReclamations {
            let recipients = reclamation.recipientControllerInstanceIds
            let delivered = reclamation.deliveredControllerInstanceIds
            guard recipients == recipients.sorted(),
                  Set(recipients).count == recipients.count,
                  recipients.allSatisfy({ !$0.isEmpty }),
                  delivered == delivered.sorted(),
                  Set(delivered).count == delivered.count,
                  delivered.allSatisfy({ !$0.isEmpty }),
                  Set(delivered).isSubset(of: Set(recipients)) else {
                throw SurfAceLocklessAuthorityError.invalidState(
                    "controller_retention_reclamation_delivery:\(reclamation.eventId)"
                )
            }
        }
        let pendingTombstones = pendingTombstoneReclamations ?? []
        guard Set(pendingTombstones.map(\.eventId)).count == pendingTombstones.count else {
            throw SurfAceLocklessAuthorityError.invalidState("tombstone_reclamation_outbox")
        }
        for reclamation in pendingTombstones {
            let recipients = reclamation.recipientControllerInstanceIds
            let delivered = reclamation.deliveredControllerInstanceIds
            guard recipients == recipients.sorted(), Set(recipients).count == recipients.count,
                  delivered == delivered.sorted(), Set(delivered).count == delivered.count,
                  Set(delivered).isSubset(of: Set(recipients)) else {
                throw SurfAceLocklessAuthorityError.invalidState("tombstone_reclamation_delivery")
            }
        }
        for (controllerId, controller) in controllers {
            guard controllerId == controller.controllerInstanceId else {
                throw SurfAceLocklessAuthorityError.invalidState("controller_key")
            }
            let receipts = Array(controller.pendingOperationReceipts.values)
            guard Int64(receipts.count) <= limits.maxPendingOperationReceiptsPerController else {
                throw SurfAceLocklessAuthorityError.invalidState("operation_receipt_entries:\(controllerId)")
            }
            var receiptBytes: Int64 = 0
            for receipt in receipts {
                guard controller.pendingOperationReceipts[receipt.requestId] == receipt else {
                    throw SurfAceLocklessAuthorityError.invalidState("operation_receipt_key:\(controllerId)")
                }
                let exact = try SurfAceLocklessExactDurableAccounting.receiptBytes(receipt)
                guard receipt.bytes == exact else {
                    throw SurfAceLocklessAuthorityError.invalidState(
                        "operation_receipt_exact_bytes:\(controllerId):\(receipt.requestId)"
                    )
                }
                receiptBytes = SurfAceLocklessExactDurableAccounting.saturatingAdd(receiptBytes, exact)
            }
            guard receiptBytes <= limits.maxPendingOperationReceiptBytesPerController else {
                throw SurfAceLocklessAuthorityError.invalidState("operation_receipt_bytes:\(controllerId)")
            }
        }
        let dormant = controllers.values.filter { $0.status == .dormant }
        guard dormant.allSatisfy({ ($0.dormantSequence ?? 0) > 0 }) else {
            throw SurfAceLocklessAuthorityError.invalidState("dormant_controller_sequence")
        }
        let dormantSequences = dormant.compactMap(\.dormantSequence)
        guard Set(dormantSequences).count == dormantSequences.count else {
            throw SurfAceLocklessAuthorityError.invalidState("duplicate_dormant_controller_sequence")
        }
        let usage = try SurfAceLocklessDormantRetention.usage(in: self)
        guard usage.entryCount <= limits.maxDormantControllerEntries else {
            throw SurfAceLocklessAuthorityError.invalidState("dormant_controller_entries")
        }
        guard usage.bytes <= limits.maxDormantControllerBytes else {
            throw SurfAceLocklessAuthorityError.invalidState("dormant_controller_bytes")
        }
        try SurfAceLocklessDormantRetention.validateCursorState(in: self)
        for (path, scope) in SurfAceLocklessDormantRetention.allScopes(in: self) {
            try SurfAceLocklessConsumableOperations.validateRestoredScope(
                scope,
                limits: limits,
                path: path
            )
        }

        var targetBytesBySurface: [String: Int64] = [:]
        for (key, work) in targetApplyWorkItems {
            guard key == work.identity.storageKey else {
                throw SurfAceLocklessAuthorityError.invalidState("target_work_key")
            }
            let exact = try SurfAceLocklessExactDurableAccounting.targetWorkBytes(work)
            guard work.bytes == exact else {
                throw SurfAceLocklessAuthorityError.invalidState("target_work_exact_bytes:\(work.operationRequestId)")
            }
            targetBytesBySurface[work.surfaceId] = SurfAceLocklessExactDurableAccounting.saturatingAdd(
                targetBytesBySurface[work.surfaceId] ?? 0,
                exact
            )
        }
        for (key, result) in targetApplyResults {
            guard key == result.identity.storageKey else {
                throw SurfAceLocklessAuthorityError.invalidState("target_result_key")
            }
        }
        for (surfaceId, targetBytes) in targetBytesBySurface {
            guard let surface = liveSurfaces[surfaceId]
                    ?? surfaceTombstones.first(where: { $0.surface.surfaceId == surfaceId })?.surface else {
                throw SurfAceLocklessAuthorityError.invalidState("target_work_surface:\(surfaceId)")
            }
            let baseBytes = try SurfAceLocklessTopologyOperations.surfaceBaseBytes(surface)
            guard SurfAceLocklessExactDurableAccounting.saturatingAdd(baseBytes, targetBytes)
                    <= limits.maxSurfaceRecoverableBaseBytes else {
                throw SurfAceLocklessAuthorityError.invalidState("target_work_bytes:\(surfaceId)")
            }
        }
    }

    func validated(
        for transition: SurfAceLocklessRecoverableTransition,
        limits replacementLimits: SurfAceLocklessCapacityLimits? = nil
    ) throws -> Self {
        var candidate = self
        if let replacementLimits { candidate.limits = replacementLimits }
        do {
            try candidate.validate()
            return candidate
        } catch let error as SurfAceLocklessTopologyOperationError {
            throw error
        } catch {
            throw error
        }
    }
}

enum SurfAceLocklessRecoverableTransition: String, Sendable {
    case configuration
    case locklessAdmission
    case restart
}

enum SurfAceLocklessExactDurableAccounting {
    private struct VersionedReceipt: Encodable {
        var bytes: Int64
        var commitSequence: Int64?
        var operation: String
        var outcome: String?
        var requestId: String
        var status: SurfAceLocklessReceiptStatus
        var terminalResponse: SurfAceLocklessJSON?
        let version = 1
    }

    private struct VersionedTargetWork: Encodable {
        var bytes: Int64
        var controllerInstanceId: String
        var intentCommitSequence: Int64
        var operationRequestId: String
        var request: SurfAceLocklessJSON
        var state: SurfAceLocklessTargetWorkState
        var surfaceId: String
        var targetEpoch: Int64
        var targetId: String
        var targetRequestId: String
        let version = 1
    }

    static func receiptBytes(_ receipt: SurfAceLocklessOperationReceiptState) throws -> Int64 {
        try fixedPointBytes { bytes in
            VersionedReceipt(
                bytes: bytes,
                commitSequence: receipt.commitSequence,
                operation: receipt.operation,
                outcome: receipt.outcome,
                requestId: receipt.requestId,
                status: receipt.status,
                terminalResponse: receipt.terminalResponse
            )
        }
    }

    static func targetWorkBytes(_ work: SurfAceLocklessTargetWorkItem) throws -> Int64 {
        try fixedPointBytes { bytes in
            VersionedTargetWork(
                bytes: bytes,
                controllerInstanceId: work.controllerInstanceId,
                intentCommitSequence: work.intentCommitSequence,
                operationRequestId: work.operationRequestId,
                request: work.request,
                state: work.state,
                surfaceId: work.surfaceId,
                targetEpoch: work.targetEpoch,
                targetId: work.targetId,
                targetRequestId: work.targetRequestId
            )
        }
    }

    static func saturatingAdd(_ left: Int64, _ right: Int64) -> Int64 {
        let (sum, overflow) = left.addingReportingOverflow(right)
        return overflow ? .max : sum
    }

    private static func fixedPointBytes<Value: Encodable>(
        _ value: (Int64) -> Value
    ) throws -> Int64 {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        var bytes: Int64 = 0
        while true {
            let next = Int64(try encoder.encode(value(bytes)).count)
            guard next != bytes else { return next }
            bytes = next
        }
    }
}

struct SurfAceLocklessDormantRetentionUsage: Equatable, Sendable {
    var bytes: Int64
    var bytesByController: [String: Int64]
    var entryCount: Int64
}

enum SurfAceLocklessDormantRetention {
    private struct RetentionScope {
        var path: String
        var scope: SurfAceLocklessConsumableScope
        var surfaceId: String
        var tombstoneId: String?
        var tombstoned: Bool
    }

    private struct VersionedRegistryRecord: Encodable {
        var bundle: SurfAceLocklessControllerBundle
        let version = 1
    }

    private struct VersionedCursorRecord: Encodable {
        var controllerInstanceId: String
        var cursor: SurfAceLocklessConsumableCursor
        var scopeId: String
        let version = 1
    }

    static func usage(in state: SurfAceLocklessAuthorityState) throws -> SurfAceLocklessDormantRetentionUsage {
        let dormant = state.controllers.values
            .filter { $0.status == .dormant }
            .sorted(by: retentionOrder)
        var charges = Dictionary(uniqueKeysWithValues: dormant.map { ($0.controllerInstanceId, Int64(0)) })

        for bundle in dormant {
            charges[bundle.controllerInstanceId, default: 0] += try encodedBytes(
                VersionedRegistryRecord(bundle: bundle)
            )
        }

        for (scopeId, scope) in allScopes(in: state) {
            for bundle in dormant {
                guard let cursor = scope.cursors[bundle.controllerInstanceId] else { continue }
                charges[bundle.controllerInstanceId, default: 0] += try encodedBytes(
                    VersionedCursorRecord(
                        controllerInstanceId: bundle.controllerInstanceId,
                        cursor: cursor,
                        scopeId: scopeId
                    )
                )
            }
            for record in scope.records + Array(scope.liveFrames.values) {
                let readers = scope.cursors.compactMap { controllerId, cursor in
                    cursor.cursor <= record.sequence ? state.controllers[controllerId] : nil
                }
                guard !readers.contains(where: { $0.status == .live }) else { continue }
                guard let charged = readers
                    .filter({ $0.status == .dormant })
                    .sorted(by: retentionOrder)
                    .first else { continue }
                charges[charged.controllerInstanceId, default: 0] += record.bytes
            }
        }

        return SurfAceLocklessDormantRetentionUsage(
            bytes: charges.values.reduce(0, +),
            bytesByController: charges,
            entryCount: Int64(dormant.count)
        )
    }

    static func validateCursorState(in state: SurfAceLocklessAuthorityState) throws {
        for (scopeId, scope) in allScopes(in: state) {
            guard Int64(scope.cursors.count) <= state.limits.maxAdmittedControllerEntries else {
                throw SurfAceLocklessAuthorityError.invalidState("consumable_cursor_entries:\(scopeId)")
            }
            for (controllerId, cursor) in scope.cursors {
                guard state.controllers[controllerId] != nil else {
                    throw SurfAceLocklessAuthorityError.invalidState("consumable_cursor_controller:\(scopeId)")
                }
                let bytes = try encodedBytes(VersionedCursorRecord(
                    controllerInstanceId: controllerId,
                    cursor: cursor,
                    scopeId: scopeId
                ))
                guard bytes <= state.limits.maxConsumableCursorStateBytesPerScope else {
                    throw SurfAceLocklessAuthorityError.invalidState("consumable_cursor_bytes:\(scopeId)")
                }
            }
        }
    }

    @discardableResult
    static func enforceBounds(
        in state: inout SurfAceLocklessAuthorityState,
        trigger: String = "transaction_enforcement"
    ) throws -> [SurfAceLocklessControllerRetentionReclamation] {
        var reclaimed: [SurfAceLocklessControllerRetentionReclamation] = []
        while true {
            let current = try usage(in: state)
            let countExceeded = current.entryCount > state.limits.maxDormantControllerEntries
            let bytesExceeded = current.bytes > state.limits.maxDormantControllerBytes
            guard countExceeded || bytesExceeded else {
                return reclaimed
            }
            guard let victim = oldestDormantController(in: state) else {
                throw SurfAceLocklessAuthorityError.invalidState("dormant_controller_bounds")
            }
            let reason = countExceeded && bytesExceeded
                ? "count_and_byte_capacity"
                : (countExceeded ? "count_capacity" : "byte_capacity")
            reclaimed.append(try reclaim(victim, trigger: trigger, reason: reason, in: &state))
        }
    }

    @discardableResult
    static func reclaimOldest(
        in state: inout SurfAceLocklessAuthorityState,
        trigger: String = "controller_admission",
        reason: String = "entry_capacity"
    ) throws -> SurfAceLocklessControllerRetentionReclamation? {
        guard let victim = oldestDormantController(in: state) else { return nil }
        return try reclaim(victim, trigger: trigger, reason: reason, in: &state)
    }

    private static func reclaim(
        _ victim: SurfAceLocklessControllerBundle,
        trigger: String,
        reason: String,
        in state: inout SurfAceLocklessAuthorityState
    ) throws -> SurfAceLocklessControllerRetentionReclamation {
        let controllerId = victim.controllerInstanceId
        let affected = retentionScopes(in: state).filter { $0.scope.cursors[controllerId] != nil }
        var cursorBytes: Int64 = 0
        var liveCursorBytes: Int64 = 0
        var surfaceCursorBytes: Int64 = 0
        var tombstoneCursorBytes: Int64 = 0
        var liveCursorCount: Int64 = 0
        var surfaceCursorCount: Int64 = 0
        var tombstoneCursorCount: Int64 = 0
        var unreadBytes: Int64 = 0
        var unreadBytesDiscarded: Int64 = 0
        var unreadFrameCount: Int64 = 0
        var unreadFrameCountDiscarded: Int64 = 0
        var unreadRecordCount: Int64 = 0
        var unreadRecordCountDiscarded: Int64 = 0
        for entry in affected {
            guard let cursor = entry.scope.cursors[controllerId] else { continue }
            let bytes = try encodedBytes(VersionedCursorRecord(
                controllerInstanceId: controllerId,
                cursor: cursor,
                scopeId: entry.path
            ))
            cursorBytes = SurfAceLocklessExactDurableAccounting.saturatingAdd(cursorBytes, bytes)
            if entry.tombstoned {
                tombstoneCursorCount += 1
                tombstoneCursorBytes = SurfAceLocklessExactDurableAccounting.saturatingAdd(
                    tombstoneCursorBytes, bytes
                )
            } else {
                liveCursorCount += 1
                liveCursorBytes = SurfAceLocklessExactDurableAccounting.saturatingAdd(liveCursorBytes, bytes)
            }
            if entry.scope.scopeKind == "surface" {
                surfaceCursorCount += 1
                surfaceCursorBytes = SurfAceLocklessExactDurableAccounting.saturatingAdd(
                    surfaceCursorBytes, bytes
                )
            }
            for record in entry.scope.records where cursor.cursor <= record.sequence {
                unreadRecordCount += 1
                unreadBytes = SurfAceLocklessExactDurableAccounting.saturatingAdd(unreadBytes, record.bytes)
                let retained = entry.scope.cursors.contains { otherId, otherCursor in
                    otherId != controllerId && otherCursor.cursor <= record.sequence
                }
                if !retained {
                    unreadRecordCountDiscarded += 1
                    unreadBytesDiscarded = SurfAceLocklessExactDurableAccounting.saturatingAdd(
                        unreadBytesDiscarded, record.bytes
                    )
                }
            }
            for record in entry.scope.liveFrames.values where cursor.cursor <= record.sequence {
                unreadFrameCount += 1
                unreadBytes = SurfAceLocklessExactDurableAccounting.saturatingAdd(unreadBytes, record.bytes)
                let retained = entry.scope.cursors.contains { otherId, otherCursor in
                    otherId != controllerId && otherCursor.cursor <= record.sequence
                }
                if !retained {
                    unreadFrameCountDiscarded += 1
                    unreadBytesDiscarded = SurfAceLocklessExactDurableAccounting.saturatingAdd(
                        unreadBytesDiscarded, record.bytes
                    )
                }
            }
        }
        let commitSequence = state.sequences.nextCommitSequence
        let receipts = Array(victim.pendingOperationReceipts.values)
        let diagnostic = SurfAceLocklessControllerRetentionReclamation(
            commitSequence: commitSequence,
            controllerInstanceId: controllerId,
            cursorBytes: cursorBytes,
            cursorCount: Int64(affected.count),
            disconnectedAt: victim.disconnectedAt,
            deliveredControllerInstanceIds: [],
            dormantSequence: victim.dormantSequence ?? 0,
            eventId: "controller-reclamation:\(commitSequence)",
            liveCursorBytes: liveCursorBytes,
            liveCursorCount: liveCursorCount,
            maxAdmittedControllerEntries: state.limits.maxAdmittedControllerEntries,
            maxDormantControllerBytes: state.limits.maxDormantControllerBytes,
            maxDormantControllerEntries: state.limits.maxDormantControllerEntries,
            reason: reason,
            recipientControllerInstanceIds: state.controllers.values
                .filter { $0.status == .live }
                .map(\.controllerInstanceId)
                .sorted(),
            receiptBytes: receipts.reduce(Int64(0)) {
                SurfAceLocklessExactDurableAccounting.saturatingAdd($0, $1.bytes)
            },
            receiptCount: Int64(receipts.count),
            registryBytes: try encodedBytes(VersionedRegistryRecord(bundle: victim)),
            scopeCount: Int64(affected.count),
            surfaceCount: Int64(Set(affected.map(\.surfaceId)).count),
            surfaceCursorBytes: surfaceCursorBytes,
            surfaceCursorCount: surfaceCursorCount,
            tombstoneCount: Int64(Set(affected.compactMap(\.tombstoneId)).count),
            tombstoneCursorBytes: tombstoneCursorBytes,
            tombstoneCursorCount: tombstoneCursorCount,
            trigger: trigger,
            unreadBytes: unreadBytes,
            unreadBytesDiscarded: unreadBytesDiscarded,
            unreadFrameCount: unreadFrameCount,
            unreadFrameCountDiscarded: unreadFrameCountDiscarded,
            unreadRecordCount: unreadRecordCount,
            unreadRecordCountDiscarded: unreadRecordCountDiscarded
        )
        var pending = state.pendingControllerRetentionReclamations ?? []
        pending.append(diagnostic)
        state.pendingControllerRetentionReclamations = pending
        state.sequences.nextCommitSequence += 1
        state.controllers.removeValue(forKey: controllerId)
        SurfAceLocklessConsumableOperations.reclaimController(controllerId, in: &state)
        return diagnostic
    }

    private static func oldestDormantController(
        in state: SurfAceLocklessAuthorityState
    ) -> SurfAceLocklessControllerBundle? {
        state.controllers.values.filter { $0.status == .dormant }.sorted(by: retentionOrder).first
    }

    private static func retentionOrder(
        _ left: SurfAceLocklessControllerBundle,
        _ right: SurfAceLocklessControllerBundle
    ) -> Bool {
        (left.dormantSequence ?? .max, left.controllerInstanceId)
            < (right.dormantSequence ?? .max, right.controllerInstanceId)
    }

    static func allScopes(
        in state: SurfAceLocklessAuthorityState
    ) -> [(String, SurfAceLocklessConsumableScope)] {
        var result = state.scopes.map { ($0.key, $0.value) }
        for surface in state.liveSurfaces.values {
            result += surface.paneTombstones.map {
                ("pane-tombstone:\(surface.surfaceId):\($0.tombstoneId):\($0.scope.scopeId)", $0.scope)
            }
        }
        for tombstone in state.surfaceTombstones {
            result += tombstone.scopes.map {
                ("surface-tombstone:\(tombstone.tombstoneId):\($0.key)", $0.value)
            }
            result += tombstone.surface.paneTombstones.map {
                ("surface-tombstone:\(tombstone.tombstoneId):pane-tombstone:\($0.tombstoneId):\($0.scope.scopeId)", $0.scope)
            }
        }
        return result.sorted { $0.0 < $1.0 }
    }

    private static func retentionScopes(in state: SurfAceLocklessAuthorityState) -> [RetentionScope] {
        var result: [RetentionScope] = []
        for (scopeId, scope) in state.scopes {
            let encodedSurfaceId = scopeId.split(separator: ":").dropFirst().first.map(String.init) ?? scopeId
            let surfaceId = encodedSurfaceId.removingPercentEncoding ?? encodedSurfaceId
            result.append(.init(
                path: scopeId, scope: scope, surfaceId: surfaceId,
                tombstoneId: nil, tombstoned: false
            ))
        }
        for surface in state.liveSurfaces.values {
            for tombstone in surface.paneTombstones {
                let path = "pane-tombstone:\(surface.surfaceId):\(tombstone.tombstoneId):\(tombstone.scope.scopeId)"
                result.append(.init(
                    path: path, scope: tombstone.scope,
                    surfaceId: surface.surfaceId,
                    tombstoneId: "pane:\(tombstone.tombstoneId)", tombstoned: true
                ))
            }
        }
        for tombstone in state.surfaceTombstones {
            for (scopeId, scope) in tombstone.scopes {
                let path = "surface-tombstone:\(tombstone.tombstoneId):\(scopeId)"
                result.append(.init(
                    path: path, scope: scope,
                    surfaceId: tombstone.surface.surfaceId,
                    tombstoneId: "surface:\(tombstone.tombstoneId)", tombstoned: true
                ))
            }
            for paneTombstone in tombstone.surface.paneTombstones {
                let path = "surface-tombstone:\(tombstone.tombstoneId):pane-tombstone:\(paneTombstone.tombstoneId):\(paneTombstone.scope.scopeId)"
                result.append(.init(
                    path: path, scope: paneTombstone.scope,
                    surfaceId: tombstone.surface.surfaceId,
                    tombstoneId: "surface:\(tombstone.tombstoneId):pane:\(paneTombstone.tombstoneId)",
                    tombstoned: true
                ))
            }
        }
        return result.sorted { $0.path < $1.path }
    }

    private static func encodedBytes<T: Encodable>(_ value: T) throws -> Int64 {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return Int64(try encoder.encode(value).count)
    }
}

enum SurfAceLocklessAuthorityError: Error, Equatable {
    case invalidLimit(String)
    case invalidState(String)
    case unsupportedVersion
}

struct SurfAceLocklessGenerationStore: Sendable {
    let stateURL: URL

    func load() throws -> SurfAceLocklessAuthorityState? {
        guard FileManager.default.fileExists(atPath: stateURL.path) else { return nil }
        let state = try JSONDecoder().decode(
            SurfAceLocklessAuthorityState.self,
            from: Data(contentsOf: stateURL)
        )
        return try state.validated(for: .restart)
    }

    func save(_ state: SurfAceLocklessAuthorityState) throws {
        try state.validate()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let bytes = try encoder.encode(state)
        let directory = stateURL.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let temporaryURL = directory.appendingPathComponent(".\(stateURL.lastPathComponent).next")
        try bytes.write(to: temporaryURL)
        let handle = try FileHandle(forWritingTo: temporaryURL)
        try handle.synchronize()
        try handle.close()
        if FileManager.default.fileExists(atPath: stateURL.path) {
            _ = try FileManager.default.replaceItemAt(stateURL, withItemAt: temporaryURL)
        } else {
            try FileManager.default.moveItem(at: temporaryURL, to: stateURL)
        }
    }
}

final class SurfAceLocklessTransactionCoordinator: @unchecked Sendable {
    private let queue = DispatchQueue(label: "co.clicketyclacks.SurfAce.lockless-authority")
    private var state: SurfAceLocklessAuthorityState
    private let store: SurfAceLocklessGenerationStore

    init(state: SurfAceLocklessAuthorityState, store: SurfAceLocklessGenerationStore) throws {
        try state.validate()
        self.state = state
        self.store = store
    }

    convenience init(store: SurfAceLocklessGenerationStore) throws {
        try self.init(state: store.load() ?? .empty(), store: store)
    }

    func snapshot() async -> SurfAceLocklessAuthorityState {
        await withCheckedContinuation { continuation in
            queue.async { continuation.resume(returning: self.state) }
        }
    }

    func transact<Result: Sendable>(
        trigger: String = "transaction_enforcement",
        _ operation: @escaping @Sendable (inout SurfAceLocklessAuthorityState) throws -> Result
    ) async throws -> Result {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                var candidate = self.state
                do {
                    let result = try operation(&candidate)
                    try SurfAceLocklessDormantRetention.enforceBounds(
                        in: &candidate,
                        trigger: trigger
                    )
                    candidate.generation += 1
                    try candidate.validate()
                    try self.store.save(candidate)
                    self.state = candidate
                    continuation.resume(returning: result)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }
}
