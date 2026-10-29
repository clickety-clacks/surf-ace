import CryptoKit
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
    var maxAnnotationPublisherStateBytesPerSurface: Int64?
    var maxAnnotationPublisherRecordsPerSurface: Int64?

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
        maxPendingOperationReceiptBytesPerController: 8 * 1_024 * 1_024,
        maxAnnotationPublisherStateBytesPerSurface: nil,
        maxAnnotationPublisherRecordsPerSurface: nil
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
        if let bytes = maxAnnotationPublisherStateBytesPerSurface,
           let records = maxAnnotationPublisherRecordsPerSurface {
            guard bytes >= 2 * 8_192 + 1_024,
                  bytes <= Int64(SurfAceAnnotationOutbox.maximumBytes),
                  records >= 2, records <= Int64(SurfAceAnnotationOutbox.maximumRecords) else {
                throw SurfAceLocklessAuthorityError.invalidLimit("annotation_publisher")
            }
        } else if maxAnnotationPublisherStateBytesPerSurface != nil || maxAnnotationPublisherRecordsPerSurface != nil {
            throw SurfAceLocklessAuthorityError.invalidLimit("annotation_publisher")
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
    var allocationGeneration: Int64? = nil
    var history: SurfAceLocklessHistory
    var name: String?
    var paneId: Int64
    var paneLabel: Int64
    var paneLineageId: String
    var target: SurfAceLocklessJSON?
}

enum SurfAceLocklessTombstoneOrigin: String, Codable, Equatable, Sendable {
    case explicitPaneClose = "explicit_pane_close"
    case explicitWindowClose = "explicit_window_close"
    case ambiguous
}

struct SurfAceLocklessPaneTombstone: Codable, Equatable, Sendable {
    var bytes: Int64
    var closedSequence: Int64
    var origin: SurfAceLocklessTombstoneOrigin? = nil
    var pane: SurfAceLocklessPaneMaterial
    var scope: SurfAceLocklessConsumableScope
    var tombstoneId: String
}

struct SurfAceLocklessSurfaceMaterial: Codable, Equatable, Sendable {
    var allocationGeneration: Int64? = nil
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
    // nil denotes a pre-marker persisted surface; treat its label as legacy evidence.
    var windowLabelConfirmed: Bool? = nil
}

struct SurfAceLocklessSurfaceTombstone: Codable, Equatable, Sendable {
    var bytes: Int64
    var closedSequence: Int64
    var origin: SurfAceLocklessTombstoneOrigin? = nil
    var scopes: [String: SurfAceLocklessConsumableScope]
    var surface: SurfAceLocklessSurfaceMaterial
    var tombstoneId: String
}

struct SurfAceLocklessFinalCloseRecord: Codable, Equatable, Sendable {
    enum AllocationKind: String, Codable, Equatable, Sendable { case pane, surface }

    var allocationGeneration: Int64?
    var allocationKind: AllocationKind
    var allocatorId: String?
    var clientId: String?
    var closedSequence: Int64
    var closeTopologyRevision: Int64
    var fleetId: String?
    var paneId: Int64?
    var paneLabel: Int64?
    var paneLineageId: String?
    var recordId: String
    var sourceTombstoneId: String
    var sourceTombstoneKind: SurfAceLocklessTombstoneReclamation.Kind
    var surfaceId: String
    var terminalRetirementRevision: Int64
    var windowLabel: String?
}

struct SurfAceLocklessAllocationReleaseIntent: Codable, Equatable, Sendable {
    var allocationGeneration: Int64?
    var allocationKind: SurfAceLocklessFinalCloseRecord.AllocationKind
    var allocatorId: String?
    var clientId: String?
    var closeTopologyRevision: Int64
    var fleetId: String?
    var idempotencyKey: String
    var paneId: Int64?
    var paneLabel: Int64?
    var paneLineageId: String?
    var releaseId: String
    var recordId: String
    var sourceTombstoneId: String
    var sourceTombstoneKind: SurfAceLocklessTombstoneReclamation.Kind
    var status: Status
    var surfaceId: String
    var terminalRetirementRevision: Int64
    var windowLabel: String?

    enum Status: String, Codable, Equatable, Sendable { case pending, accepted }
}

enum SurfAceLocklessAllocationReleaseIdentity {
    static func matches(_ intent: SurfAceLocklessAllocationReleaseIntent) -> Bool {
        guard let allocationGeneration = intent.allocationGeneration,
              let clientId = intent.clientId else { return false }
        switch intent.allocationKind {
        case .pane:
            guard let lineageId = intent.paneLineageId,
                  let paneId = intent.paneId,
                  let paneLabel = intent.paneLabel else { return false }
            return pane(
                allocationGeneration: allocationGeneration,
                clientId: clientId,
                closeRevision: intent.closeTopologyRevision,
                lineageId: lineageId,
                paneId: String(paneId),
                paneLabel: paneLabel,
                surfaceId: intent.surfaceId,
                terminalRetirementRevision: intent.terminalRetirementRevision,
                tombstoneId: intent.sourceTombstoneId,
                tombstoneKind: intent.sourceTombstoneKind
            ) == intent.releaseId
        case .surface:
            guard let windowLabel = intent.windowLabel else { return false }
            let canonical = window(
                allocationGeneration: allocationGeneration,
                clientId: clientId,
                closeRevision: intent.closeTopologyRevision,
                surfaceId: intent.surfaceId,
                terminalRetirementRevision: intent.terminalRetirementRevision,
                tombstoneId: intent.sourceTombstoneId,
                tombstoneKind: intent.sourceTombstoneKind,
                windowLabel: windowLabel
            )
            let legacy = legacyWindow(
                allocationGeneration: allocationGeneration,
                clientId: clientId,
                closeRevision: intent.closeTopologyRevision,
                surfaceId: intent.surfaceId,
                terminalRetirementRevision: intent.terminalRetirementRevision,
                tombstoneId: intent.sourceTombstoneId,
                tombstoneKind: intent.sourceTombstoneKind,
                windowLabel: windowLabel
            )
            return canonical == intent.releaseId || legacy == intent.releaseId
        }
    }

    static func pane(
        allocationGeneration: Int64,
        clientId: String,
        closeRevision: Int64,
        lineageId: String,
        paneId: String,
        paneLabel: Int64,
        surfaceId: String,
        terminalRetirementRevision: Int64,
        tombstoneId: String,
        tombstoneKind: SurfAceLocklessTombstoneReclamation.Kind
    ) -> String? {
        guard allocationGeneration > 0,
              safeInteger(closeRevision),
              paneLabel > 0,
              terminalRetirementRevision > 0,
              validClientId(clientId),
              validSurfaceId(surfaceId),
              validLineageId(lineageId),
              paneId.range(of: #"^[1-9][0-9]{0,15}$"#, options: .regularExpression) != nil,
              validTombstoneId(tombstoneId),
              tombstoneKind == .pane || tombstoneKind == .surface else { return nil }
        let json = "{\"allocationGeneration\":\(allocationGeneration),\"clientId\":\"\(clientId)\",\"closeRevision\":\(closeRevision),\"lineageId\":\"\(lineageId)\",\"paneId\":\"\(paneId)\",\"paneLabel\":\(paneLabel),\"surfaceId\":\"\(surfaceId)\",\"terminalRetirementRevision\":\(terminalRetirementRevision),\"tombstoneId\":\"\(tombstoneId)\",\"tombstoneKind\":\"\(tombstoneKind.rawValue)\"}"
        return digest(json)
    }

    static func window(
        allocationGeneration: Int64,
        clientId: String,
        closeRevision: Int64,
        surfaceId: String,
        terminalRetirementRevision: Int64,
        tombstoneId: String,
        tombstoneKind: SurfAceLocklessTombstoneReclamation.Kind,
        windowLabel: String
    ) -> String? {
        windowWithGenerationKey(
            allocationGeneration: allocationGeneration, clientId: clientId,
            closeRevision: closeRevision, surfaceId: surfaceId,
            terminalRetirementRevision: terminalRetirementRevision,
            tombstoneId: tombstoneId, tombstoneKind: tombstoneKind,
            windowLabel: windowLabel, generationKey: "windowGeneration"
        )
    }

    static func legacyWindow(
        allocationGeneration: Int64,
        clientId: String,
        closeRevision: Int64,
        surfaceId: String,
        terminalRetirementRevision: Int64,
        tombstoneId: String,
        tombstoneKind: SurfAceLocklessTombstoneReclamation.Kind,
        windowLabel: String
    ) -> String? {
        windowWithGenerationKey(
            allocationGeneration: allocationGeneration, clientId: clientId,
            closeRevision: closeRevision, surfaceId: surfaceId,
            terminalRetirementRevision: terminalRetirementRevision,
            tombstoneId: tombstoneId, tombstoneKind: tombstoneKind,
            windowLabel: windowLabel, generationKey: "allocationGeneration"
        )
    }

    private static func windowWithGenerationKey(
        allocationGeneration: Int64,
        clientId: String,
        closeRevision: Int64,
        surfaceId: String,
        terminalRetirementRevision: Int64,
        tombstoneId: String,
        tombstoneKind: SurfAceLocklessTombstoneReclamation.Kind,
        windowLabel: String,
        generationKey: String
    ) -> String? {
        guard allocationGeneration > 0,
              safeInteger(closeRevision),
              terminalRetirementRevision > 0,
              validClientId(clientId),
              validSurfaceId(surfaceId),
              validTombstoneId(tombstoneId),
              tombstoneKind == .surface,
              windowLabel.range(of: #"^[a-z]{1,32}$"#, options: .regularExpression) != nil else { return nil }
        let identityFields = "\"clientId\":\"\(clientId)\",\"closeRevision\":\(closeRevision),\"surfaceId\":\"\(surfaceId)\",\"terminalRetirementRevision\":\(terminalRetirementRevision),\"tombstoneId\":\"\(tombstoneId)\",\"tombstoneKind\":\"surface\""
        let generationField = "\"\(generationKey)\":\(allocationGeneration)"
        // The registry hashes windowGeneration after tombstoneKind. Keep the
        // former allocationGeneration-first order only for durable legacy IDs.
        let fields = generationKey == "windowGeneration"
            ? "\(identityFields),\(generationField),\"windowLabel\":\"\(windowLabel)\""
            : "\(generationField),\(identityFields),\"windowLabel\":\"\(windowLabel)\""
        let json = "{\(fields)}"
        return digest(json)
    }

    private static func digest(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }

    private static func safeInteger(_ value: Int64) -> Bool {
        value >= 0 && value <= 9_007_199_254_740_991
    }

    private static func validClientId(_ value: String) -> Bool {
        value.range(of: #"^[a-f0-9]{64}$"#, options: .regularExpression) != nil
    }

    private static func validSurfaceId(_ value: String) -> Bool {
        value.range(of: #"^sf_[A-Za-z0-9._:-]{3,64}$"#, options: .regularExpression) != nil
    }

    private static func validLineageId(_ value: String) -> Bool {
        value.range(of: #"^pl_[A-Za-z0-9._:-]{3,128}$"#, options: .regularExpression) != nil
    }

    private static func validTombstoneId(_ value: String) -> Bool {
        value.range(of: #"^[A-Za-z0-9._:-]{1,128}$"#, options: .regularExpression) != nil
    }
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
    var allocationReleaseIntents: [SurfAceLocklessAllocationReleaseIntent]? = nil
    var annotationPublisher: SurfAceAnnotationOutbox?
    var capability: String
    var controllers: [String: SurfAceLocklessControllerBundle]
    var generation: Int64
    var limits: SurfAceLocklessCapacityLimits
    var liveSurfaces: [String: SurfAceLocklessSurfaceMaterial]
    var pendingControllerRetentionReclamations: [SurfAceLocklessControllerRetentionReclamation]?
    var pendingTombstoneReclamations: [SurfAceLocklessTombstoneReclamation]?
    var registryBinding: SurfAceRegistryBinding?
    var rememberedTailnetEndpoint: SurfAceRememberedTailnetEndpoint? = nil
    var unconfirmedMigration: SurfAceUnconfirmedMigrationReceipt?
    var sceneSurfaceIds: [String: String]
    var scopes: [String: SurfAceLocklessConsumableScope]
    var sequences: SurfAceLocklessClientSequences
    var surfaceSetRevision: Int64
    var surfaceTombstones: [SurfAceLocklessSurfaceTombstone]
    var targetApplyResults: [String: SurfAceLocklessTargetResult]
    var targetApplyWorkItems: [String: SurfAceLocklessTargetWorkItem]
    var terminalCloseRecords: [SurfAceLocklessFinalCloseRecord]? = nil
    var version: Int

    static func empty(limits: SurfAceLocklessCapacityLimits = .production) throws -> Self {
        try limits.validate()
        return SurfAceLocklessAuthorityState(
            allocationReleaseIntents: [],
            annotationPublisher: nil,
            capability: surfAceLocklessCapability,
            controllers: [:],
            generation: 0,
            limits: limits,
            liveSurfaces: [:],
            pendingControllerRetentionReclamations: [],
            pendingTombstoneReclamations: [],
            registryBinding: nil,
            rememberedTailnetEndpoint: nil,
            unconfirmedMigration: nil,
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
            terminalCloseRecords: [],
            version: 1
        )
    }

    func validate() throws {
        guard version == 1, capability == surfAceLocklessCapability, generation >= 0 else {
            throw SurfAceLocklessAuthorityError.unsupportedVersion
        }
        if let unconfirmedMigration {
            guard !unconfirmedMigration.clientId.isEmpty,
                  !unconfirmedMigration.evidenceId.isEmpty,
                  !unconfirmedMigration.allocationHistoryEvidence.isEmpty,
                  !unconfirmedMigration.localProvenanceEvidence.isEmpty,
                  !unconfirmedMigration.otherFleetCheckEvidence.isEmpty,
                  !unconfirmedMigration.localClaims.isEmpty else {
                throw SurfAceLocklessAuthorityError.invalidState("unconfirmed_migration_evidence")
            }
        }
        if let registryBinding {
            guard !registryBinding.clientId.isEmpty,
                  SurfAceRegistryIdentity(
                    allocatorId: registryBinding.allocatorId, fleetId: registryBinding.fleetId
                  ).isValid else {
                throw SurfAceLocklessAuthorityError.invalidState("registry_binding")
            }
        }
        try limits.validate()
        if let annotationPublisher {
            guard let maxBytes = limits.maxAnnotationPublisherStateBytesPerSurface,
                  let maxRecords = limits.maxAnnotationPublisherRecordsPerSurface else {
                throw SurfAceLocklessAuthorityError.invalidState("annotation_publisher_limits")
            }
            try annotationPublisher.validate(maxBytes: Int(maxBytes), maxRecords: Int(maxRecords))
            // Source records remain pending even if §4.8 later reclaims the
            // surface tombstone; their acknowledgement is independent.
        }
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
        let finalCloseRecords = terminalCloseRecords ?? []
        guard Set(finalCloseRecords.map(\.recordId)).count == finalCloseRecords.count,
              finalCloseRecords.allSatisfy({
                  !$0.recordId.isEmpty && !$0.surfaceId.isEmpty && !$0.sourceTombstoneId.isEmpty
                      && $0.closedSequence > 0 && $0.closeTopologyRevision >= 0
                      && $0.terminalRetirementRevision > 0
                      && ($0.allocationGeneration.map { $0 > 0 } ?? true)
                      && ($0.allocationKind == .pane
                          ? $0.paneId != nil && $0.paneLineageId?.isEmpty == false && $0.windowLabel == nil
                          : $0.paneId == nil && $0.paneLineageId == nil && $0.paneLabel == nil)
              }) else {
            throw SurfAceLocklessAuthorityError.invalidState("terminal_close_records")
        }
        let releaseIntents = allocationReleaseIntents ?? []
        guard Set(releaseIntents.map(\.recordId)).count == releaseIntents.count,
              Set(releaseIntents.map(\.releaseId)).count == releaseIntents.count,
              releaseIntents.allSatisfy({ intent in
                  SurfAceLocklessAllocationReleaseIdentity.matches(intent)
                      && intent.idempotencyKey == intent.releaseId
                      && !intent.recordId.isEmpty
                      && !intent.surfaceId.isEmpty
                      && !intent.sourceTombstoneId.isEmpty
                      && (finalCloseRecords.contains(where: { $0.recordId == intent.recordId })
                          || intent.status == .accepted)
              }) else {
            throw SurfAceLocklessAuthorityError.invalidState("allocation_release_intents")
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

        for (key, work) in targetApplyWorkItems {
            guard key == work.identity.storageKey else {
                throw SurfAceLocklessAuthorityError.invalidState("target_work_key")
            }
            guard liveSurfaces[work.surfaceId] != nil
                    || surfaceTombstones.contains(where: { $0.surface.surfaceId == work.surfaceId }) else {
                throw SurfAceLocklessAuthorityError.invalidState("target_work_surface:\(work.surfaceId)")
            }
            let exact = try SurfAceLocklessExactDurableAccounting.targetWorkBytes(work)
            guard work.bytes == exact else {
                throw SurfAceLocklessAuthorityError.invalidState("target_work_exact_bytes:\(work.operationRequestId)")
            }

        }
        for (key, result) in targetApplyResults {
            guard key == result.identity.storageKey else {
                throw SurfAceLocklessAuthorityError.invalidState("target_result_key")
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
        try SurfAceLocklessConsumableOperations.reclaimController(controllerId, in: &state)
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
        let bytes = try Data(contentsOf: stateURL)
        do {
            let state = try JSONDecoder().decode(SurfAceLocklessAuthorityState.self, from: bytes)
            return try state.validated(for: .restart)
        } catch {
            return try salvageReadableState(from: bytes)
        }
    }

    private func salvageReadableState(from bytes: Data) throws -> SurfAceLocklessAuthorityState {
        guard let root = (try? JSONSerialization.jsonObject(with: bytes, options: [.fragmentsAllowed])) as? [String: Any]
        else { return try .empty() }

        var state = try SurfAceLocklessAuthorityState.empty()
        if let limits = decode(root["limits"], as: SurfAceLocklessCapacityLimits.self),
           (try? limits.validate()) != nil {
            state.limits = limits
        }
        state.generation = max(0, integer(root["generation"]) ?? 0)
        state.surfaceSetRevision = max(0, integer(root["surfaceSetRevision"]) ?? 0)
        let savedSequences = root["sequences"] as? [String: Any] ?? [:]
        state.sequences = SurfAceLocklessClientSequences(
            nextClosedSequence: recoveredSequence(savedSequences["nextClosedSequence"]),
            nextCommitSequence: recoveredSequence(savedSequences["nextCommitSequence"]),
            nextDormantSequence: recoveredSequence(savedSequences["nextDormantSequence"]),
            nextSurfaceId: recoveredSequence(savedSequences["nextSurfaceId"]),
            nextSurfaceLabel: recoveredSequence(savedSequences["nextSurfaceLabel"])
        )
        let savedBinding = decode(root["registryBinding"], as: SurfAceRegistryBinding.self)
        state.registryBinding = savedBinding.flatMap { binding in
            guard !binding.clientId.isEmpty,
                  SurfAceRegistryIdentity(allocatorId: binding.allocatorId, fleetId: binding.fleetId).isValid else {
                return nil
            }
            return binding
        }
        state.rememberedTailnetEndpoint = decode(
            root["rememberedTailnetEndpoint"], as: SurfAceRememberedTailnetEndpoint.self
        ).flatMap { remembered in
            guard remembered.isValid,
                  let binding = state.registryBinding,
                  binding.allocatorId == remembered.registryIdentity.allocatorId,
                  binding.fleetId == remembered.registryIdentity.fleetId else { return nil }
            return remembered
        }
        // Pre-binding migration receipts have no role in recovery.
        state.unconfirmedMigration = nil
        state.annotationPublisher = salvageAnnotationOutbox(root["annotationPublisher"])
        if let outbox = state.annotationPublisher {
            if state.limits.maxAnnotationPublisherStateBytesPerSurface == nil {
                state.limits.maxAnnotationPublisherStateBytesPerSurface = Int64(SurfAceAnnotationOutbox.maximumBytes)
            }
            if state.limits.maxAnnotationPublisherRecordsPerSurface == nil {
                state.limits.maxAnnotationPublisherRecordsPerSurface = Int64(SurfAceAnnotationOutbox.maximumRecords)
            }
            let maxBytes = state.limits.maxAnnotationPublisherStateBytesPerSurface.map(Int.init)
                ?? SurfAceAnnotationOutbox.maximumBytes
            let maxRecords = state.limits.maxAnnotationPublisherRecordsPerSurface.map(Int.init)
                ?? SurfAceAnnotationOutbox.maximumRecords
            if (try? outbox.validate(maxBytes: maxBytes, maxRecords: maxRecords)) == nil {
                state.annotationPublisher = nil
            }
        }

        if let rawControllers = root["controllers"] as? [String: Any] {
            for (key, raw) in rawControllers {
                guard let controller = decode(raw, as: SurfAceLocklessControllerBundle.self),
                      controller.controllerInstanceId == key else { continue }
                state.controllers[key] = controller
            }
        }
        if let rawScopes = root["scopes"] as? [String: Any] {
            for (key, raw) in rawScopes {
                guard var scope = decode(raw, as: SurfAceLocklessConsumableScope.self) else { continue }
                scope.scopeId = key
                scope.cursors = scope.cursors.filter { state.controllers[$0.key] != nil }
                state.scopes[key] = scope
            }
        }

        if let rawSurfaces = root["liveSurfaces"] as? [String: Any] {
            for (key, raw) in rawSurfaces {
                guard var surface = salvageSurface(raw), surface.surfaceId == key else { continue }
                clearUnknownCursorOwners(in: &surface, controllers: state.controllers)
                state.liveSurfaces[key] = surface
            }
        }
        if let rawTombstones = root["surfaceTombstones"] as? [Any] {
            for raw in rawTombstones {
                guard var tombstone = salvageSurfaceTombstone(raw),
                      !state.liveSurfaces.keys.contains(tombstone.surface.surfaceId),
                      !state.surfaceTombstones.contains(where: { $0.surface.surfaceId == tombstone.surface.surfaceId }) else {
                    continue
                }
                clearUnknownCursorOwners(in: &tombstone, controllers: state.controllers)
                state.surfaceTombstones.append(tombstone)
            }
        }
        let savedSceneSurfaceIds = decode(root["sceneSurfaceIds"], as: [String: String].self) ?? [:]
        state.sceneSurfaceIds = savedSceneSurfaceIds.filter { _, surfaceId in
            state.liveSurfaces[surfaceId] != nil || state.surfaceTombstones.contains { $0.surface.surfaceId == surfaceId }
        }

        state.terminalCloseRecords = salvageArray(root["terminalCloseRecords"], as: SurfAceLocklessFinalCloseRecord.self)
            .filter { record in
                !record.recordId.isEmpty && !record.surfaceId.isEmpty && !record.sourceTombstoneId.isEmpty
                    && record.closedSequence > 0 && record.closeTopologyRevision >= 0
                    && record.terminalRetirementRevision > 0
                    && (record.allocationGeneration.map { $0 > 0 } ?? true)
                    && (record.allocationKind == .pane
                        ? record.paneId != nil && record.paneLineageId?.isEmpty == false && record.windowLabel == nil
                        : record.paneId == nil && record.paneLineageId == nil && record.paneLabel == nil)
            }
        var uniqueCloseRecords: [SurfAceLocklessFinalCloseRecord] = []
        var closeIds = Set<String>()
        for record in state.terminalCloseRecords ?? [] where closeIds.insert(record.recordId).inserted {
            uniqueCloseRecords.append(record)
        }
        state.terminalCloseRecords = uniqueCloseRecords
        var releaseIntents: [SurfAceLocklessAllocationReleaseIntent] = salvageArray(
            root["allocationReleaseIntents"], as: SurfAceLocklessAllocationReleaseIntent.self
        )
        let closeRecordIds = Set(uniqueCloseRecords.map(\.recordId))
        let validCloseRecordIds = closeRecordIds
        releaseIntents = releaseIntents.filter { intent in
            SurfAceLocklessAllocationReleaseIdentity.matches(intent)
                && intent.idempotencyKey == intent.releaseId
                && (intent.status == .accepted || validCloseRecordIds.contains(intent.recordId))
        }
        var releaseIds = Set<String>()
        var releaseRecordIds = Set<String>()
        releaseIntents = releaseIntents.filter {
            releaseIds.insert($0.releaseId).inserted && releaseRecordIds.insert($0.recordId).inserted
        }
        state.allocationReleaseIntents = releaseIntents
        state.pendingControllerRetentionReclamations = salvageArray(
            root["pendingControllerRetentionReclamations"], as: SurfAceLocklessControllerRetentionReclamation.self
        )
        state.pendingTombstoneReclamations = salvageArray(
            root["pendingTombstoneReclamations"], as: SurfAceLocklessTombstoneReclamation.self
        )
        state.targetApplyResults = salvageDictionary(root["targetApplyResults"], as: SurfAceLocklessTargetResult.self)
            .filter { $0.key == $0.value.identity.storageKey }
        let targetWorkItems = salvageDictionary(root["targetApplyWorkItems"], as: SurfAceLocklessTargetWorkItem.self)
            .filter { key, work in
                key == work.identity.storageKey && (state.liveSurfaces[work.surfaceId] != nil
                    || state.surfaceTombstones.contains { $0.surface.surfaceId == work.surfaceId })
            }
        state.targetApplyWorkItems = targetWorkItems
        for key in Array(state.targetApplyWorkItems.keys) {
            guard var work = state.targetApplyWorkItems[key],
                  let bytes = try? SurfAceLocklessExactDurableAccounting.targetWorkBytes(work) else {
                state.targetApplyWorkItems.removeValue(forKey: key)
                continue
            }
            work.bytes = bytes
            state.targetApplyWorkItems[key] = work
        }

        ensureReadableSurfaceScopes(in: &state)
        try reconcileRecoveredSequences(in: &state)
        if let validated = try? state.validated(for: .restart) { return validated }
        return try salvageContentSurfaces(from: state)
    }

    private func recoveredSequence(_ value: Any?) -> Int64 {
        guard let sequence = decode(value, as: Int64.self), sequence > 0 else { return 1 }
        return sequence
    }

    private func reconcileRecoveredSequences(in state: inout SurfAceLocklessAuthorityState) throws {
        let surfaces = Array(state.liveSurfaces.values) + state.surfaceTombstones.map(\.surface)
        let retainedPaneTombstones = surfaces.flatMap(\.paneTombstones)

        let closedSequenceHighWater = (
            state.surfaceTombstones.map(\.closedSequence)
                + retainedPaneTombstones.map(\.closedSequence)
                + (state.terminalCloseRecords ?? []).map(\.closedSequence)
                + (state.pendingTombstoneReclamations ?? []).map(\.closedSequence)
        ).max() ?? 0
        state.sequences.nextClosedSequence = try nextSequence(
            state.sequences.nextClosedSequence, beyond: closedSequenceHighWater
        )

        var retainedCommitSequences: [Int64] = []
        for controller in state.controllers.values {
            for receipt in controller.pendingOperationReceipts.values {
                if let sequence = receipt.commitSequence {
                    retainedCommitSequences.append(sequence)
                }
            }
        }
        retainedCommitSequences.append(
            contentsOf: (state.pendingControllerRetentionReclamations ?? []).map(\.commitSequence)
        )
        retainedCommitSequences.append(
            contentsOf: (state.pendingTombstoneReclamations ?? []).map(\.commitSequence)
        )
        retainedCommitSequences.append(contentsOf: state.targetApplyWorkItems.values.map(\.intentCommitSequence))
        retainedCommitSequences.append(contentsOf: state.targetApplyResults.values.map(\.intentCommitSequence))
        let commitSequenceHighWater = retainedCommitSequences.max() ?? 0
        state.sequences.nextCommitSequence = try nextSequence(
            state.sequences.nextCommitSequence, beyond: commitSequenceHighWater
        )

        let dormantSequenceHighWater = (
            state.controllers.values.compactMap(\.dormantSequence)
                + (state.pendingControllerRetentionReclamations ?? []).map(\.dormantSequence)
        ).max() ?? 0
        state.sequences.nextDormantSequence = try nextSequence(
            state.sequences.nextDormantSequence, beyond: dormantSequenceHighWater
        )

        let retainedSurfaceIds = Array(state.liveSurfaces.keys)
            + state.surfaceTombstones.map { $0.surface.surfaceId }
            + (state.terminalCloseRecords ?? []).map(\.surfaceId)
            + (state.allocationReleaseIntents ?? []).map(\.surfaceId)
            + Array(state.sceneSurfaceIds.values)
        let surfaceIdHighWater = retainedSurfaceIds.compactMap(surfaceIdSequence).max() ?? 0
        state.sequences.nextSurfaceId = try nextSequence(state.sequences.nextSurfaceId, beyond: surfaceIdHighWater)

        let retainedWindowLabels = state.liveSurfaces.values.map(\.windowLabel)
            + state.surfaceTombstones.map { $0.surface.windowLabel }
        let surfaceLabelHighWater = retainedWindowLabels.compactMap(surfaceLabelSequence).max() ?? 0
        state.sequences.nextSurfaceLabel = try nextSequence(
            state.sequences.nextSurfaceLabel, beyond: surfaceLabelHighWater
        )
    }

    private func nextSequence(_ value: Int64, beyond highWater: Int64) throws -> Int64 {
        guard value > 0 else { throw SurfAceLocklessAuthorityError.invalidState("client_sequences") }
        guard value > highWater else {
            guard highWater < Int64.max else {
                throw SurfAceLocklessAuthorityError.invalidState("client_sequences")
            }
            return highWater + 1
        }
        return value
    }

    private func surfaceIdSequence(_ surfaceId: String) -> Int64? {
        guard surfaceId.hasPrefix("sf_"),
              let value = UInt64(surfaceId.dropFirst(3), radix: 16), value <= UInt64(Int64.max) else {
            return nil
        }
        return Int64(value)
    }

    private func surfaceLabelSequence(_ label: String) -> Int64? {
        let scalars = label.lowercased().unicodeScalars
        guard !scalars.isEmpty else { return nil }
        var value: Int64 = 0
        for scalar in scalars {
            guard (97...122).contains(scalar.value) else { return nil }
            let digit = Int64(scalar.value - 96)
            guard value <= (Int64.max - digit) / 26 else { return nil }
            value = value * 26 + digit
        }
        return value
    }

    private func salvageContentSurfaces(from source: SurfAceLocklessAuthorityState) throws -> SurfAceLocklessAuthorityState {
        var recovered = try SurfAceLocklessAuthorityState.empty(limits: source.limits)
        recovered.generation = source.generation
        recovered.sequences = source.sequences
        recovered.surfaceSetRevision = source.surfaceSetRevision
        recovered.registryBinding = source.registryBinding
        recovered.rememberedTailnetEndpoint = source.rememberedTailnetEndpoint.flatMap { remembered in
            guard remembered.isValid,
                  let binding = source.registryBinding,
                  binding.allocatorId == remembered.registryIdentity.allocatorId,
                  binding.fleetId == remembered.registryIdentity.fleetId else { return nil }
            return remembered
        }
        recovered.annotationPublisher = source.annotationPublisher
        recovered.controllers = [:]
        recovered.terminalCloseRecords = source.terminalCloseRecords
        recovered.allocationReleaseIntents = source.allocationReleaseIntents
        recovered.sceneSurfaceIds = source.sceneSurfaceIds

        for surface in source.liveSurfaces.values.sorted(by: { $0.surfaceId < $1.surfaceId }) {
            var candidate = recovered
            var readable = surface
            clearUnknownCursorOwners(in: &readable, controllers: candidate.controllers)
            candidate.liveSurfaces[readable.surfaceId] = readable
            let candidateSurfaceIds = Set(candidate.liveSurfaces.keys)
            let candidateScopeIds = candidate.liveSurfaces.values.reduce(into: Set<String>()) { result, surface in
                result.insert(SurfAceLocklessTopologyOperations.recoverySurfaceScopeId(surface.surfaceId))
                for pane in surface.panes.values {
                    result.insert(SurfAceLocklessTopologyOperations.recoveryPaneScopeId(surface.surfaceId, pane.paneId))
                }
            }
            candidate.scopes = source.scopes.filter { key, _ in
                candidateScopeIds.contains(key)
            }
            for key in Array(candidate.scopes.keys) {
                guard var scope = candidate.scopes[key] else { continue }
                scope.cursors = scope.cursors.filter { candidate.controllers[$0.key] != nil }
                candidate.scopes[key] = scope
            }
            ensureReadableSurfaceScopes(in: &candidate)
            candidate.sceneSurfaceIds = source.sceneSurfaceIds.filter {
                candidateSurfaceIds.contains($0.value)
            }
            if let validated = try? candidate.validated(for: .restart) { recovered = validated }
        }
        for tombstone in source.surfaceTombstones.sorted(by: { $0.closedSequence < $1.closedSequence }) {
            var candidate = recovered
            var readable = tombstone
            clearUnknownCursorOwners(in: &readable, controllers: candidate.controllers)
            guard candidate.liveSurfaces[readable.surface.surfaceId] == nil else { continue }
            candidate.surfaceTombstones.append(readable)
            candidate.sceneSurfaceIds.merge(source.sceneSurfaceIds.filter { $0.value == readable.surface.surfaceId }) { _, new in new }
            if let validated = try? candidate.validated(for: .restart) { recovered = validated }
        }
        return try recovered.validated(for: .restart)
    }

    private func ensureReadableSurfaceScopes(in state: inout SurfAceLocklessAuthorityState) {
        for surface in state.liveSurfaces.values {
            let surfaceId = surface.surfaceId
            let surfaceScope = SurfAceLocklessTopologyOperations.recoverySurfaceScopeId(surfaceId)
            if state.scopes[surfaceScope] == nil {
                state.scopes[surfaceScope] = SurfAceLocklessTopologyOperations.recoveryEmptyScope(
                    id: surfaceScope, kind: "surface", controllers: state.controllers
                )
            }
            for pane in surface.panes.values {
                let scopeId = SurfAceLocklessTopologyOperations.recoveryPaneScopeId(surfaceId, pane.paneId)
                if state.scopes[scopeId] == nil {
                    state.scopes[scopeId] = SurfAceLocklessTopologyOperations.recoveryEmptyScope(
                        id: scopeId, kind: "pane", controllers: state.controllers
                    )
                }
            }
        }
        for key in Array(state.scopes.keys) {
            guard var scope = state.scopes[key] else { continue }
            scope.cursors = scope.cursors.filter { state.controllers[$0.key] != nil }
            state.scopes[key] = scope
        }
    }

    private func clearUnknownCursorOwners(
        in surface: inout SurfAceLocklessSurfaceMaterial,
        controllers: [String: SurfAceLocklessControllerBundle]
    ) {
        for index in surface.paneTombstones.indices {
            surface.paneTombstones[index].scope.cursors = surface.paneTombstones[index].scope.cursors.filter {
                controllers[$0.key] != nil
            }
            if let bytes = try? SurfAceLocklessTopologyOperations.restoredPaneTombstoneBytes(
                closedSequence: surface.paneTombstones[index].closedSequence,
                pane: surface.paneTombstones[index].pane,
                scope: surface.paneTombstones[index].scope,
                tombstoneId: surface.paneTombstones[index].tombstoneId
            ) { surface.paneTombstones[index].bytes = bytes }
        }
    }

    private func clearUnknownCursorOwners(
        in tombstone: inout SurfAceLocklessSurfaceTombstone,
        controllers: [String: SurfAceLocklessControllerBundle]
    ) {
        clearUnknownCursorOwners(in: &tombstone.surface, controllers: controllers)
        for key in Array(tombstone.scopes.keys) {
            guard var scope = tombstone.scopes[key] else { continue }
            scope.cursors = scope.cursors.filter { controllers[$0.key] != nil }
            tombstone.scopes[key] = scope
        }
        if let bytes = try? SurfAceLocklessTopologyOperations.restoredSurfaceTombstoneBytes(
            closedSequence: tombstone.closedSequence, scopes: tombstone.scopes,
            surface: tombstone.surface, tombstoneId: tombstone.tombstoneId
        ) { tombstone.bytes = bytes }
    }

    private func salvageSurface(_ value: Any) -> SurfAceLocklessSurfaceMaterial? {
        if let surface = decode(value, as: SurfAceLocklessSurfaceMaterial.self) { return surface }
        guard let fields = value as? [String: Any],
              let rawPanes = fields["panes"] as? [String: Any] else { return nil }
        var panes: [String: SurfAceLocklessPaneMaterial] = [:]
        for (key, raw) in rawPanes {
            guard let pane = decode(raw, as: SurfAceLocklessPaneMaterial.self),
                  String(pane.paneId) == key else { continue }
            panes[key] = pane
        }
        guard !panes.isEmpty,
              let surfaceId = fields["surfaceId"] as? String else { return nil }
        var paneTombstones = (fields["paneTombstones"] as? [Any] ?? []).compactMap {
            decode($0, as: SurfAceLocklessPaneTombstone.self)
        }
        var topology = decode(fields["topology"], as: SurfAceLocklessJSON.self)
        let paneIds = Set(panes.values.map(\.paneId))
        if var current = topology {
            let topologyIds = Self.topologyPaneIds(current)
            for missing in topologyIds.subtracting(paneIds).sorted() {
                current = SurfAceLocklessTopologyOperations.recoveryRemovingPane(from: current, paneId: missing) ?? current
            }
            if Self.topologyPaneIds(current) == paneIds,
               let canonical = try? SurfAceLocklessTopologyCodec.canonical(current) {
                topology = canonical
            } else {
                topology = Self.freshTopology(for: paneIds.sorted())
            }
        }
        if topology == nil {
            topology = Self.freshTopology(for: panes.values.map(\.paneId).sorted())
        }
        let decodedSceneKeys = decode(fields["sceneKeys"], as: [String].self) ?? []
        var surface = SurfAceLocklessSurfaceMaterial(
            allocationGeneration: decode(fields["allocationGeneration"], as: Int64.self),
            name: fields["name"] as? String ?? "Surf Ace",
            nativeRestoreMaterial: decode(fields["nativeRestoreMaterial"], as: SurfAceLocklessJSON.self) ?? .object([:]),
            nextPaneId: max(integer(fields["nextPaneId"]) ?? 1, (panes.values.map(\.paneId).max() ?? 0) + 1),
            nextPaneLabel: max(integer(fields["nextPaneLabel"]) ?? 1, 1),
            paneTombstones: paneTombstones,
            panes: panes,
            sceneKeys: Array(Set(decodedSceneKeys)).sorted(),
            surfaceId: surfaceId,
            surfaceRevision: max(integer(fields["surfaceRevision"]) ?? 1, 1),
            topology: topology ?? Self.freshTopology(for: panes.values.map(\.paneId).sorted()),
            topologyRevision: max(integer(fields["topologyRevision"]) ?? 0, 0),
            windowLabel: fields["windowLabel"] as? String ?? "a",
            windowLabelConfirmed: decode(fields["windowLabelConfirmed"], as: Bool.self)
        )
        for index in paneTombstones.indices {
            paneTombstones[index].scope.cursors = [:]
            if let bytes = try? SurfAceLocklessTopologyOperations.restoredPaneTombstoneBytes(
                closedSequence: paneTombstones[index].closedSequence,
                pane: paneTombstones[index].pane, scope: paneTombstones[index].scope,
                tombstoneId: paneTombstones[index].tombstoneId
            ) { paneTombstones[index].bytes = bytes }
        }
        surface.paneTombstones = paneTombstones
        return surface
    }

    private func salvageSurfaceTombstone(_ value: Any) -> SurfAceLocklessSurfaceTombstone? {
        if let tombstone = decode(value, as: SurfAceLocklessSurfaceTombstone.self) { return tombstone }
        guard let fields = value as? [String: Any],
              let surface = fields["surface"].flatMap(salvageSurface),
              let closedSequence = integer(fields["closedSequence"]),
              let tombstoneId = fields["tombstoneId"] as? String else { return nil }
        var scopes: [String: SurfAceLocklessConsumableScope] = [:]
        if let rawScopes = fields["scopes"] as? [String: Any] {
            for (key, raw) in rawScopes {
                guard var scope = decode(raw, as: SurfAceLocklessConsumableScope.self) else { continue }
                scope.scopeId = key
                scope.cursors = [:]
                scopes[key] = scope
            }
        }
        let origin = decode(fields["origin"], as: SurfAceLocklessTombstoneOrigin.self)
        let bytes = (try? SurfAceLocklessTopologyOperations.restoredSurfaceTombstoneBytes(
            closedSequence: closedSequence, scopes: scopes, surface: surface, tombstoneId: tombstoneId
        )) ?? 0
        return SurfAceLocklessSurfaceTombstone(
            bytes: bytes, closedSequence: closedSequence, origin: origin,
            scopes: scopes, surface: surface, tombstoneId: tombstoneId
        )
    }

    private func salvageAnnotationOutbox(_ value: Any?) -> SurfAceAnnotationOutbox? {
        guard let value else { return nil }
        if let outbox = decode(value, as: SurfAceAnnotationOutbox.self) { return outbox }
        guard let fields = value as? [String: Any],
              let clientId = fields["clientId"] as? String,
              let sourceEpoch = fields["sourceEpoch"] as? String,
              var outbox = try? SurfAceAnnotationOutbox(clientId: clientId, sourceEpoch: sourceEpoch) else { return nil }
        outbox.version = decode(fields["version"], as: Int.self) ?? 1
        outbox.finalizedSurfaceIds = decode(fields["finalizedSurfaceIds"], as: [String].self)
        if let rawSurfaces = fields["surfaces"] as? [String: Any] {
            for (surfaceId, raw) in rawSurfaces {
                guard let surface = decode(raw, as: SurfAceAnnotationSurfaceOutbox.self) else { continue }
                outbox.surfaces[surfaceId] = surface
            }
        }
        return outbox
    }

    private func salvageDictionary<Value: Decodable>(_ value: Any?, as type: Value.Type) -> [String: Value] {
        guard let fields = value as? [String: Any] else { return [:] }
        return fields.compactMapValues { decode($0, as: type) }
    }

    private func salvageArray<Value: Decodable>(_ value: Any?, as type: Value.Type) -> [Value] {
        guard let values = value as? [Any] else { return [] }
        return values.compactMap { decode($0, as: type) }
    }

    private func decode<Value: Decodable>(_ value: Any?, as type: Value.Type) -> Value? {
        guard let value,
              let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]) else { return nil }
        return try? JSONDecoder().decode(type, from: data)
    }

    private func integer(_ value: Any?) -> Int64? {
        guard let value = value as? NSNumber else { return nil }
        return value.int64Value
    }

    private static func topologyPaneIds(_ topology: SurfAceLocklessJSON) -> Set<Int64> {
        switch topology {
        case .object(let fields):
            if case .string("pane") = fields["type"], case .integer(let paneId) = fields["paneId"] {
                return [paneId]
            }
            if case .array(let children) = fields["children"] {
                return children.reduce(into: Set<Int64>()) { $0.formUnion(topologyPaneIds($1)) }
            }
            return []
        case .array(let values):
            return values.reduce(into: Set<Int64>()) { $0.formUnion(topologyPaneIds($1)) }
        default:
            return []
        }
    }

    private static func freshTopology(for paneIds: [Int64]) -> SurfAceLocklessJSON {
        let leaves = paneIds.map { SurfAceLocklessJSON.object(["paneId": .integer($0), "type": .string("pane")]) }
        guard leaves.count > 1 else { return leaves.first ?? .null }
        return .object([
            "children": .array(leaves), "direction": .string("horizontal"), "type": .string("split")
        ])
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

    func registryBindingDurableSnapshot() async throws -> SurfAceLocklessAuthorityState {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    let stored = try self.store.load()
                    if let binding = self.state.registryBinding {
                        guard stored?.registryBinding == binding else {
                            throw SurfAceRegistrationError.registryBindingPersistencePending
                        }
                    } else if let stored, stored.registryBinding != nil {
                        var comparable = stored
                        comparable.registryBinding = nil
                        comparable.generation = self.state.generation
                        guard comparable == self.state else {
                            throw SurfAceRegistrationError.registryBindingPersistencePending
                        }
                        self.state = stored
                    }
                    if stored?.unconfirmedMigration != self.state.unconfirmedMigration {
                        guard self.state.unconfirmedMigration == nil,
                              let stored,
                              let receipt = stored.unconfirmedMigration,
                              receipt.localClaims == SurfAceProvisionedRegistryBinding.confirmedClaims(self.state),
                              SurfAceProvisionedRegistryBinding.confirmedClaims(stored).isEmpty else {
                            throw SurfAceRegistrationError.registryBindingPersistencePending
                        }
                        self.state = stored
                    }
                    continuation.resume(returning: self.state)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func reconcileRegistryBinding(
        _ binding: SurfAceRegistryBinding
    ) async throws -> SurfAceLocklessAuthorityState {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    guard let stored = try self.store.load(), stored.registryBinding == binding else {
                        throw SurfAceRegistrationError.registryBindingPersistencePending
                    }
                    try stored.validate()
                    self.state = stored
                    continuation.resume(returning: stored)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func reconcileUnconfirmedMigration(
        _ receipt: SurfAceUnconfirmedMigrationReceipt
    ) async throws -> SurfAceLocklessAuthorityState {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do {
                    guard let stored = try self.store.load(),
                          stored.unconfirmedMigration == receipt,
                          stored.registryBinding == nil,
                          SurfAceProvisionedRegistryBinding.confirmedClaims(stored).isEmpty else {
                        throw SurfAceRegistrationError.registryBindingPersistencePending
                    }
                    self.state = stored
                    continuation.resume(returning: stored)
                } catch {
                    continuation.resume(throwing: error)
                }
            }
        }
    }

    func transact<Result: Sendable>(
        trigger: String = "transaction_enforcement",
        skipUnchanged: Bool = false,
        _ operation: @escaping @Sendable (inout SurfAceLocklessAuthorityState) throws -> Result
    ) async throws -> Result {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                var candidate = self.state
                do {
                    let result = try operation(&candidate)
                    // Decide under the same serial queue as the read and prospective mutation.
                    // No-op receipt requests must not enforce retention or write a generation.
                    if skipUnchanged && candidate == self.state {
                        continuation.resume(returning: result)
                        return
                    }
                    try SurfAceLocklessDormantRetention.enforceBounds(
                        in: &candidate,
                        trigger: trigger
                    )
                    candidate.generation += 1
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
