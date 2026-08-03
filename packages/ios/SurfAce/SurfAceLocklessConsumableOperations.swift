import Foundation

enum SurfAceLocklessConsumableOperationsError: Error, Equatable, Sendable {
    case controllerNotAdmitted(String)
    case invalidScopeKind(String)
    case liveFrameRequiresPaneScope
    case scopeKindMismatch(String)
    case unknownScope(String)
}

struct SurfAceLocklessConsumableOccurrence: Equatable, Sendable {
    var affectedGaps: [String: SurfAceLocklessConsumableGap]
    var record: SurfAceLocklessConsumableRecord
    var retained: Bool
}

struct SurfAceLocklessConsumableScopeSnapshot: Codable, Equatable, Sendable {
    var cursor: SurfAceLocklessConsumableCursor
    var firstRetainedSequence: Int64
    var lastRetainedSequence: Int64
    var records: [SurfAceLocklessConsumableRecord]
    var scopeId: String
    var version: Int
}

struct SurfAceLocklessConsumableDelta: Codable, Equatable, Sendable {
    var firstRetainedSequence: Int64
    var lastRetainedSequence: Int64
    var records: [SurfAceLocklessConsumableRecord]
    var scopeId: String
}

struct SurfAceLocklessConsumableAcknowledgement: Codable, Equatable, Sendable {
    var acceptedCursor: Int64
    var acceptedGapGeneration: Int64
}

struct SurfAceLocklessConsumableAcknowledgementIntent: Codable, Equatable, Sendable {
    var cursor: Int64
    var gapGeneration: Int64?
    var scopeId: String
}

enum SurfAceLocklessConsumableOperations {
    private struct VersionedRecord: Encodable {
        var payload: SurfAceLocklessJSON
        var recordClass: SurfAceLocklessConsumableRecordClass
        var recordId: String
        var sequence: Int64
        let version = 1
    }

    private static let latestWinsClasses: [SurfAceLocklessConsumableRecordClass] = [
        .scroll, .selection, .page, .playback, .navigation,
    ]

    private static let eventClasses: [SurfAceLocklessConsumableRecordClass] = [
        .tap, .content, .history, .topology,
    ]

    static func ensureScope(
        in state: inout SurfAceLocklessAuthorityState,
        scopeId: String,
        scopeKind: String
    ) throws {
        guard scopeKind == "pane" || scopeKind == "surface" else {
            throw SurfAceLocklessConsumableOperationsError.invalidScopeKind(scopeKind)
        }
        if let existing = state.scopes[scopeId] {
            guard existing.scopeKind == scopeKind else {
                throw SurfAceLocklessConsumableOperationsError.scopeKindMismatch(scopeId)
            }
            return
        }
        let cursors = Dictionary(uniqueKeysWithValues: state.controllers.keys.sorted().map {
            ($0, SurfAceLocklessConsumableCursor(cursor: 1, gap: nil, gapGeneration: 0))
        })
        state.scopes[scopeId] = SurfAceLocklessConsumableScope(
            cursors: cursors,
            liveFrames: [:],
            nextSequence: 1,
            records: [],
            scopeId: scopeId,
            scopeKind: scopeKind
        )
    }

    static func restoredRecordBytes(_ record: SurfAceLocklessConsumableRecord) throws -> Int64 {
        try makeRecord(
            payload: record.payload,
            recordClass: record.recordClass,
            recordId: record.recordId,
            sequence: record.sequence
        ).bytes
    }

    /// Adds the persistent cursor projection required when an identity is first admitted.
    /// A newly admitted identity starts at the current tail and does not acquire historical work.
    static func admitController(
        _ controllerInstanceId: String,
        in state: inout SurfAceLocklessAuthorityState
    ) {
        for scopeId in state.scopes.keys.sorted() {
            guard var scope = state.scopes[scopeId], scope.cursors[controllerInstanceId] == nil else {
                continue
            }
            scope.cursors[controllerInstanceId] = SurfAceLocklessConsumableCursor(
                cursor: scope.nextSequence,
                gap: nil,
                gapGeneration: 0
            )
            state.scopes[scopeId] = scope
        }
    }

    static func appendCommittedRecord(
        in state: inout SurfAceLocklessAuthorityState,
        scopeId: String,
        scopeKind: String,
        recordId: String,
        recordClass: SurfAceLocklessConsumableRecordClass,
        payload: SurfAceLocklessJSON
    ) throws -> SurfAceLocklessConsumableOccurrence {
        var working = state
        try ensureScope(in: &working, scopeId: scopeId, scopeKind: scopeKind)
        guard var scope = working.scopes[scopeId] else {
            throw SurfAceLocklessConsumableOperationsError.unknownScope(scopeId)
        }
        let record = try makeRecord(
            payload: payload,
            recordClass: recordClass,
            recordId: recordId,
            sequence: scope.nextSequence
        )
        scope.nextSequence = saturatingIncrement(scope.nextSequence)

        if latestWinsClasses.contains(recordClass) {
            scope.records.removeAll { $0.recordClass == recordClass }
        }

        let limits = scopeLimits(for: scope.scopeKind, state: working)
        var affectedGaps: [String: SurfAceLocklessConsumableGap] = [:]
        if record.bytes > working.limits.maxConsumableRecordBytes || record.bytes > limits.bytes {
            affectedGaps = applyLoss(to: &scope, lostRecords: [record], cause: "record_oversize")
            working.scopes[scopeId] = scope
            state = working
            return .init(affectedGaps: affectedGaps, record: record, retained: false)
        }

        scope.records.append(record)
        var victims: [SurfAceLocklessConsumableRecord] = []
        while Int64(scope.records.count + scope.liveFrames.count) > limits.records
                || retainedBytes(scope) > limits.bytes {
            victims.append(scope.records.removeFirst())
        }
        if !victims.isEmpty {
            affectedGaps = applyLoss(to: &scope, lostRecords: victims, cause: "scope_capacity")
        }
        let retained = scope.records.contains { $0.recordId == record.recordId }
        working.scopes[scopeId] = scope
        state = working
        return .init(affectedGaps: affectedGaps, record: record, retained: retained)
    }

    static func updateLiveFrame(
        in state: inout SurfAceLocklessAuthorityState,
        scopeId: String,
        frameId: String,
        payload: SurfAceLocklessJSON
    ) throws -> SurfAceLocklessConsumableOccurrence {
        var working = state
        try ensureScope(in: &working, scopeId: scopeId, scopeKind: "pane")
        guard var scope = working.scopes[scopeId] else {
            throw SurfAceLocklessConsumableOperationsError.unknownScope(scopeId)
        }
        guard scope.scopeKind == "pane" else {
            throw SurfAceLocklessConsumableOperationsError.liveFrameRequiresPaneScope
        }
        let record = try makeRecord(
            payload: payload,
            recordClass: .annotationFrame,
            recordId: frameId,
            sequence: scope.nextSequence
        )
        scope.nextSequence = saturatingIncrement(scope.nextSequence)
        let limit = working.limits.maxPaneConsumableBytes
        if record.bytes > working.limits.maxConsumableRecordBytes || record.bytes > limit {
            scope.liveFrames.removeValue(forKey: frameId)
            let gaps = applyLoss(to: &scope, lostRecords: [record], cause: "record_oversize")
            working.scopes[scopeId] = scope
            state = working
            return .init(affectedGaps: gaps, record: record, retained: false)
        }

        scope.liveFrames[frameId] = record
        var victims: [SurfAceLocklessConsumableRecord] = []
        while Int64(scope.records.count + scope.liveFrames.count)
                > working.limits.maxPaneConsumableRecords
                || retainedBytes(scope) > limit {
            guard !scope.records.isEmpty else {
                scope.liveFrames.removeValue(forKey: frameId)
                let gaps = applyLoss(to: &scope, lostRecords: [record], cause: "scope_capacity")
                working.scopes[scopeId] = scope
                state = working
                return .init(affectedGaps: gaps, record: record, retained: false)
            }
            victims.append(scope.records.removeFirst())
        }
        let gaps = applyLoss(to: &scope, lostRecords: victims, cause: "scope_capacity")
        working.scopes[scopeId] = scope
        state = working
        return .init(affectedGaps: gaps, record: record, retained: true)
    }

    static func finalizeLiveFrame(
        in state: inout SurfAceLocklessAuthorityState,
        scopeId: String,
        frameId: String,
        recordId: String
    ) throws -> SurfAceLocklessConsumableOccurrence? {
        guard var scope = state.scopes[scopeId], let frame = scope.liveFrames[frameId] else {
            return nil
        }
        var working = state
        scope.liveFrames.removeValue(forKey: frameId)
        working.scopes[scopeId] = scope
        let occurrence = try appendCommittedRecord(
            in: &working,
            scopeId: scopeId,
            scopeKind: "pane",
            recordId: recordId,
            recordClass: .annotationFrame,
            payload: frame.payload
        )
        state = working
        return occurrence
    }

    static func snapshot(
        in state: SurfAceLocklessAuthorityState,
        controllerInstanceId: String,
        scopeId: String
    ) throws -> SurfAceLocklessConsumableScopeSnapshot {
        guard let scope = state.scopes[scopeId] else {
            throw SurfAceLocklessConsumableOperationsError.unknownScope(scopeId)
        }
        guard let cursor = scope.cursors[controllerInstanceId] else {
            throw SurfAceLocklessConsumableOperationsError.controllerNotAdmitted(controllerInstanceId)
        }
        let records = projectionRecords(scope)
        return .init(
            cursor: cursor,
            firstRetainedSequence: records.first?.sequence ?? scope.nextSequence,
            lastRetainedSequence: scope.nextSequence - 1,
            records: records,
            scopeId: scopeId,
            version: 1
        )
    }

    static func delta(
        in state: SurfAceLocklessAuthorityState,
        controllerInstanceId: String,
        scopeId: String
    ) throws -> SurfAceLocklessConsumableDelta {
        let snapshot = try snapshot(
            in: state,
            controllerInstanceId: controllerInstanceId,
            scopeId: scopeId
        )
        return .init(
            firstRetainedSequence: snapshot.firstRetainedSequence,
            lastRetainedSequence: snapshot.lastRetainedSequence,
            records: snapshot.records.filter { $0.sequence >= snapshot.cursor.cursor },
            scopeId: scopeId
        )
    }

    static func acknowledge(
        in state: inout SurfAceLocklessAuthorityState,
        controllerInstanceId: String,
        scopeId: String,
        cursor requestedCursor: Int64,
        gapGeneration: Int64?
    ) throws -> SurfAceLocklessConsumableAcknowledgement {
        var working = state
        guard var scope = working.scopes[scopeId] else {
            throw SurfAceLocklessConsumableOperationsError.unknownScope(scopeId)
        }
        guard var cursor = scope.cursors[controllerInstanceId] else {
            throw SurfAceLocklessConsumableOperationsError.controllerNotAdmitted(controllerInstanceId)
        }
        cursor.cursor = max(cursor.cursor, min(max(1, requestedCursor), scope.nextSequence))
        if let gapGeneration, cursor.gap?.generation == gapGeneration {
            cursor.gap = nil
            cursor.gapGeneration = gapGeneration
        }
        scope.cursors[controllerInstanceId] = cursor
        dropFullyConsumedRecords(from: &scope)
        working.scopes[scopeId] = scope
        state = working
        return .init(
            acceptedCursor: cursor.cursor,
            acceptedGapGeneration: cursor.gapGeneration
        )
    }

    static func reclaimController(
        _ controllerInstanceId: String,
        in state: inout SurfAceLocklessAuthorityState
    ) {
        for scopeId in state.scopes.keys.sorted() {
            guard var scope = state.scopes[scopeId] else { continue }
            removeController(controllerInstanceId, from: &scope)
            state.scopes[scopeId] = scope
        }
        for surfaceId in state.liveSurfaces.keys.sorted() {
            guard var surface = state.liveSurfaces[surfaceId] else { continue }
            for index in surface.paneTombstones.indices {
                removeController(controllerInstanceId, from: &surface.paneTombstones[index].scope)
            }
            state.liveSurfaces[surfaceId] = surface
        }
        for surfaceIndex in state.surfaceTombstones.indices {
            for scopeId in state.surfaceTombstones[surfaceIndex].scopes.keys.sorted() {
                guard var scope = state.surfaceTombstones[surfaceIndex].scopes[scopeId] else { continue }
                removeController(controllerInstanceId, from: &scope)
                state.surfaceTombstones[surfaceIndex].scopes[scopeId] = scope
            }
            for paneIndex in state.surfaceTombstones[surfaceIndex].surface.paneTombstones.indices {
                removeController(
                    controllerInstanceId,
                    from: &state.surfaceTombstones[surfaceIndex].surface.paneTombstones[paneIndex].scope
                )
            }
        }
    }

    static func validateRestoredScope(
        _ scope: SurfAceLocklessConsumableScope,
        limits: SurfAceLocklessCapacityLimits,
        path: String
    ) throws {
        guard scope.scopeKind == "pane" || scope.scopeKind == "surface" else {
            throw SurfAceLocklessAuthorityError.invalidState("consumable_scope_kind:\(path)")
        }
        guard scope.nextSequence > 0 else {
            throw SurfAceLocklessAuthorityError.invalidState("consumable_next_sequence:\(path)")
        }
        guard scope.scopeKind == "pane" || scope.liveFrames.isEmpty else {
            throw SurfAceLocklessAuthorityError.invalidState("surface_live_frames:\(path)")
        }
        let retained = scope.records + Array(scope.liveFrames.values)
        let recordLimit = scope.scopeKind == "pane"
            ? limits.maxPaneConsumableRecords
            : limits.maxSurfaceConsumableRecords
        let byteLimit = scope.scopeKind == "pane"
            ? limits.maxPaneConsumableBytes
            : limits.maxSurfaceConsumableBytes
        guard Int64(retained.count) <= recordLimit else {
            throw SurfAceLocklessAuthorityError.invalidState("consumable_record_entries:\(path)")
        }
        guard Set(retained.map(\.recordId)).count == retained.count,
              Set(retained.map(\.sequence)).count == retained.count,
              retained.allSatisfy({ $0.sequence > 0 && $0.sequence < scope.nextSequence }) else {
            throw SurfAceLocklessAuthorityError.invalidState("consumable_record_identity:\(path)")
        }
        var bytes: Int64 = 0
        for record in retained {
            let exact = try makeRecord(
                payload: record.payload,
                recordClass: record.recordClass,
                recordId: record.recordId,
                sequence: record.sequence
            ).bytes
            guard record.bytes == exact else {
                throw SurfAceLocklessAuthorityError.invalidState("consumable_record_exact_bytes:\(path):\(record.recordId)")
            }
            guard exact <= limits.maxConsumableRecordBytes else {
                throw SurfAceLocklessAuthorityError.invalidState("consumable_record_bytes:\(path):\(record.recordId)")
            }
            bytes = saturatingAdd(bytes, exact)
        }
        guard bytes <= byteLimit else {
            throw SurfAceLocklessAuthorityError.invalidState("consumable_scope_bytes:\(path)")
        }
    }

    private static func makeRecord(
        payload: SurfAceLocklessJSON,
        recordClass: SurfAceLocklessConsumableRecordClass,
        recordId: String,
        sequence: Int64
    ) throws -> SurfAceLocklessConsumableRecord {
        let versioned = VersionedRecord(
            payload: payload,
            recordClass: recordClass,
            recordId: recordId,
            sequence: sequence
        )
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return SurfAceLocklessConsumableRecord(
            bytes: Int64(try encoder.encode(versioned).count),
            payload: payload,
            recordClass: recordClass,
            recordId: recordId,
            sequence: sequence
        )
    }

    private static func scopeLimits(
        for kind: String,
        state: SurfAceLocklessAuthorityState
    ) -> (bytes: Int64, records: Int64) {
        kind == "pane"
            ? (state.limits.maxPaneConsumableBytes, state.limits.maxPaneConsumableRecords)
            : (state.limits.maxSurfaceConsumableBytes, state.limits.maxSurfaceConsumableRecords)
    }

    private static func retainedBytes(_ scope: SurfAceLocklessConsumableScope) -> Int64 {
        saturatingAdd(
            scope.records.reduce(0) { saturatingAdd($0, $1.bytes) },
            scope.liveFrames.values.reduce(0) { saturatingAdd($0, $1.bytes) }
        )
    }

    private static func projectionRecords(
        _ scope: SurfAceLocklessConsumableScope
    ) -> [SurfAceLocklessConsumableRecord] {
        (scope.records + Array(scope.liveFrames.values)).sorted {
            ($0.sequence, $0.recordId) < ($1.sequence, $1.recordId)
        }
    }

    private static func applyLoss(
        to scope: inout SurfAceLocklessConsumableScope,
        lostRecords: [SurfAceLocklessConsumableRecord],
        cause: String
    ) -> [String: SurfAceLocklessConsumableGap] {
        guard let firstLostSequence = lostRecords.map(\.sequence).min(),
              let lastLostSequence = lostRecords.map(\.sequence).max() else { return [:] }
        let firstRetainedSequence = projectionRecords(scope).first?.sequence ?? scope.nextSequence
        let droppedBytes = lostRecords.reduce(0) { saturatingAdd($0, $1.bytes) }
        let droppedEventCount = Int64(lostRecords.filter { eventClasses.contains($0.recordClass) }.count)
        let droppedFrameCount = Int64(lostRecords.filter { $0.recordClass == .annotationFrame }.count)
        let droppedRecordCount = Int64(lostRecords.count)
        var affected: [String: SurfAceLocklessConsumableGap] = [:]

        for controllerId in scope.cursors.keys.sorted() {
            guard var cursor = scope.cursors[controllerId], cursor.cursor <= lastLostSequence else {
                continue
            }
            let previous = cursor.gap
            let previousUnknown = previous?.lossExtent == "unknown"
            let recordClasses = orderedUnion(
                previous?.recordClasses ?? [],
                lostRecords.map(\.recordClass)
            )
            cursor.cursor = max(cursor.cursor, firstRetainedSequence)
            cursor.gapGeneration = saturatingIncrement(cursor.gapGeneration)
            cursor.gap = SurfAceLocklessConsumableGap(
                cause: cause,
                droppedBytes: previousUnknown ? nil : saturatingAdd(previous?.droppedBytes ?? 0, droppedBytes),
                droppedEventCount: previousUnknown ? nil : saturatingAdd(previous?.droppedEventCount ?? 0, droppedEventCount),
                droppedFrameCount: previousUnknown ? nil : saturatingAdd(previous?.droppedFrameCount ?? 0, droppedFrameCount),
                droppedRecordCount: previousUnknown ? nil : saturatingAdd(previous?.droppedRecordCount ?? 0, droppedRecordCount),
                firstLostSequence: previousUnknown ? nil : min(previous?.firstLostSequence ?? firstLostSequence, firstLostSequence),
                generation: cursor.gapGeneration,
                lastLostSequence: previousUnknown ? nil : max(previous?.lastLostSequence ?? lastLostSequence, lastLostSequence),
                lossExtent: previousUnknown ? "unknown" : "exact",
                recordClasses: recordClasses
            )
            scope.cursors[controllerId] = cursor
            affected[controllerId] = cursor.gap!
        }
        return affected
    }

    private static func dropFullyConsumedRecords(from scope: inout SurfAceLocklessConsumableScope) {
        guard let floor = scope.cursors.values.map(\.cursor).min() else {
            scope.records.removeAll()
            scope.liveFrames.removeAll()
            return
        }
        scope.records.removeAll { $0.sequence < floor }
        scope.liveFrames = scope.liveFrames.filter { $0.value.sequence >= floor }
    }

    private static func removeController(
        _ controllerInstanceId: String,
        from scope: inout SurfAceLocklessConsumableScope
    ) {
        scope.cursors.removeValue(forKey: controllerInstanceId)
        dropFullyConsumedRecords(from: &scope)
    }

    private static func orderedUnion(
        _ left: [SurfAceLocklessConsumableRecordClass],
        _ right: [SurfAceLocklessConsumableRecordClass]
    ) -> [SurfAceLocklessConsumableRecordClass] {
        var result: [SurfAceLocklessConsumableRecordClass] = []
        for value in left + right where !result.contains(value) {
            result.append(value)
        }
        return result
    }

    private static func saturatingAdd(_ left: Int64, _ right: Int64) -> Int64 {
        let (sum, overflow) = left.addingReportingOverflow(right)
        return overflow ? Int64.max : sum
    }

    private static func saturatingIncrement(_ value: Int64) -> Int64 {
        saturatingAdd(value, 1)
    }
}
