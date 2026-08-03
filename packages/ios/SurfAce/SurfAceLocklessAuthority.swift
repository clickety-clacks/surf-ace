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
}

struct SurfAceLocklessTargetResult: Codable, Equatable, Sendable {
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
        for (surfaceId, surface) in liveSurfaces {
            guard surfaceId == surface.surfaceId else {
                throw SurfAceLocklessAuthorityError.invalidState("surface_key")
            }
            guard Int64(surface.panes.count + surface.paneTombstones.count)
                    <= limits.maxPanesPerSurface + limits.maxRetainedTombstones else {
                throw SurfAceLocklessAuthorityError.invalidState("surface_recoverable_envelope")
            }
        }
        let tombstonedSurfaceIds = Set(surfaceTombstones.map(\.surface.surfaceId))
        guard tombstonedSurfaceIds.count == surfaceTombstones.count,
              tombstonedSurfaceIds.isDisjoint(with: liveSurfaces.keys) else {
            throw SurfAceLocklessAuthorityError.invalidState("surface_lifecycle_identity")
        }
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
        try state.validate()
        return state
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
        _ operation: @escaping @Sendable (inout SurfAceLocklessAuthorityState) throws -> Result
    ) async throws -> Result {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                var candidate = self.state
                do {
                    let result = try operation(&candidate)
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
