import Foundation
import XCTest
@testable import SurfAce

final class SurfAceLocklessAuthorityTests: XCTestCase {
    func testProductionLimitsMatchCanonicalFiniteEnvelope() throws {
        let limits = SurfAceLocklessCapacityLimits.production
        try limits.validate()
        XCTAssertEqual(limits.version, 1)
        XCTAssertEqual(limits.maxPanesPerSurface, 16)
        XCTAssertEqual(limits.maxPendingOperationReceiptsPerController, 128)
        XCTAssertGreaterThanOrEqual(limits.maxRecoverableSurfaceBytes, limits.recoverableSurfaceMinimumBytes)

        var invalid = limits
        invalid.maxPaneConsumableRecords = 0
        XCTAssertThrowsError(try invalid.validate()) { error in
            XCTAssertEqual(error as? SurfAceLocklessAuthorityError, .invalidLimit("maxPaneConsumableRecords"))
        }
    }

    func testLegacyMigrationPreservesRepresentableMaterialAndDoesNotMutateSource() throws {
        let suite = "SurfAceLocklessAuthorityTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let legacy = legacySnapshot()
        defaults.set(legacy.identityMapping, forKey: SurfAceLegacyUserDefaultsSnapshot.identityMappingKey)
        defaults.set(legacy.surfaceTopologies, forKey: SurfAceLegacyUserDefaultsSnapshot.surfaceTopologyKey)
        let before = SurfAceLegacyUserDefaultsSnapshot(userDefaults: defaults)

        let state = try SurfAceLocklessMigration.migrate(before)

        XCTAssertEqual(SurfAceLegacyUserDefaultsSnapshot(userDefaults: defaults), before)
        XCTAssertEqual(state.capability, surfAceLocklessCapability)
        XCTAssertEqual(state.liveSurfaces.keys.sorted(), ["sf_1"])
        let surface = try XCTUnwrap(state.liveSurfaces["sf_1"])
        XCTAssertEqual(surface.sceneKeys, ["scene-1"])
        XCTAssertEqual(surface.windowLabel, "a")
        XCTAssertEqual(surface.panes.keys.sorted(), ["7"])
        let pane = try XCTUnwrap(surface.panes["7"])
        XCTAssertEqual(pane.paneLabel, 2)
        XCTAssertEqual(pane.paneLineageId, "pl_7")
        XCTAssertEqual(pane.history.visible.contentId, "ct_00000001")
        XCTAssertEqual(pane.history.visible.revision, 4)
        XCTAssertEqual(pane.history.back.count, 1)
        XCTAssertEqual(pane.history.forward.count, 1)
        XCTAssertNotNil(state.scopes["surface:sf_1"])
        XCTAssertNotNil(state.scopes["pane:sf_1:7"])
    }

    func testGenerationStoreRoundTripsCompleteStateAcrossRestart() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceLocklessAuthorityTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        var state = try SurfAceLocklessMigration.migrate(legacySnapshot())
        state.generation = 8
        state.controllers["controller-a"] = controllerBundle()
        state.targetApplyWorkItems["work-1"] = targetWork()
        state.targetApplyResults["result-1"] = targetResult()
        var closedSurface = try XCTUnwrap(state.liveSurfaces["sf_1"])
        closedSurface.surfaceId = "sf_2"
        closedSurface.sceneKeys = []
        state.surfaceTombstones = [surfaceTombstone(from: closedSurface)]

        try store.save(state)
        let restored = try XCTUnwrap(store.load())

        XCTAssertEqual(restored, state)
        XCTAssertEqual(restored.controllers["controller-a"]?.pendingOperationReceipts["rq-1"]?.commitSequence, 11)
        XCTAssertEqual(restored.targetApplyWorkItems["work-1"]?.state, .materializing)
        XCTAssertEqual(restored.surfaceTombstones.first?.surface.panes["7"]?.history.visible.contentId, "ct_00000001")
    }

    func testCoordinatorPersistsBeforeReturningAndSerializesGenerations() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceLocklessCoordinatorTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        let coordinator = try SurfAceLocklessTransactionCoordinator(state: .empty(), store: store)

        let first = try await coordinator.transact { state in
            let sequence = state.sequences.nextCommitSequence
            state.sequences.nextCommitSequence += 1
            return sequence
        }
        XCTAssertEqual(first, 1)
        XCTAssertEqual(try store.load()?.generation, 1)
        XCTAssertEqual(try store.load()?.sequences.nextCommitSequence, 2)

        let second = try await coordinator.transact { state in
            let sequence = state.sequences.nextCommitSequence
            state.sequences.nextCommitSequence += 1
            return sequence
        }
        XCTAssertEqual(second, 2)
        XCTAssertEqual(try store.load()?.generation, 2)
        let snapshot = await coordinator.snapshot()
        XCTAssertEqual(snapshot, try store.load())
    }

    func testCoordinatorSerializesConcurrentCallerNeutralTransactions() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceLocklessConcurrentTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        let coordinator = try SurfAceLocklessTransactionCoordinator(state: .empty(), store: store)

        let sequences = try await withThrowingTaskGroup(of: Int64.self, returning: [Int64].self) { group in
            for caller in ["controller-z", "controller-a", "local-user", "controller-m"] {
                group.addTask {
                    try await coordinator.transact { state in
                        _ = caller
                        let sequence = state.sequences.nextCommitSequence
                        state.sequences.nextCommitSequence += 1
                        return sequence
                    }
                }
            }
            return try await group.reduce(into: []) { $0.append($1) }
        }

        XCTAssertEqual(sequences.sorted(), [1, 2, 3, 4])
        XCTAssertEqual(try store.load()?.generation, 4)
        XCTAssertEqual(try store.load()?.sequences.nextCommitSequence, 5)
    }

    func testDormantRetentionAcceptsExactEntryAndByteBoundaries() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        state.controllers = [
            "controller-a": dormantBundle(id: "controller-a", sequence: 1),
            "controller-b": dormantBundle(id: "controller-b", sequence: 2),
        ]
        state.scopes["surface:one"] = retentionScope(controllerIds: ["controller-a", "controller-b"])
        let usage = try SurfAceLocklessDormantRetention.usage(in: state)
        state.limits.maxDormantControllerEntries = usage.entryCount
        state.limits.maxDormantControllerBytes = usage.bytes

        XCTAssertNoThrow(try state.validate())

        state.limits.maxDormantControllerEntries = usage.entryCount - 1
        XCTAssertThrowsError(try state.validate()) { error in
            XCTAssertEqual(error as? SurfAceLocklessAuthorityError, .invalidState("dormant_controller_entries"))
        }
        state.limits.maxDormantControllerEntries = usage.entryCount
        state.limits.maxDormantControllerBytes = usage.bytes - 1
        XCTAssertThrowsError(try state.validate()) { error in
            XCTAssertEqual(error as? SurfAceLocklessAuthorityError, .invalidState("dormant_controller_bytes"))
        }
    }

    func testGenerationLoadRejectsOverLimitDormantAndCursorStateWithoutTrimming() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceLocklessInvalidRestoreTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        state.controllers["controller-a"] = dormantBundle(id: "controller-a", sequence: 1)
        state.scopes["surface:one"] = retentionScope(controllerIds: ["controller-a"])
        let usage = try SurfAceLocklessDormantRetention.usage(in: state)
        state.limits.maxDormantControllerBytes = usage.bytes - 1
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(state).write(to: store.stateURL)

        XCTAssertThrowsError(try store.load()) { error in
            XCTAssertEqual(error as? SurfAceLocklessAuthorityError, .invalidState("dormant_controller_bytes"))
        }
        XCTAssertEqual(state.controllers.count, 1)
        XCTAssertEqual(state.scopes["surface:one"]?.cursors.count, 1)

        state.limits.maxDormantControllerBytes = .max
        state.limits.maxConsumableCursorStateBytesPerScope = 1
        try encoder.encode(state).write(to: store.stateURL)
        XCTAssertThrowsError(try store.load()) { error in
            XCTAssertEqual(
                error as? SurfAceLocklessAuthorityError,
                .invalidState("consumable_cursor_bytes:surface:one")
            )
        }
    }

    func testGenerationLoadRejectsImpossibleReclamationDeliveredRecipient() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceLocklessInvalidDeliveryTests-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        state.controllers["controller-dormant"] = dormantBundle(id: "controller-dormant", sequence: 1)
        var live = dormantBundle(id: "controller-live", sequence: 2)
        live.status = .live
        live.disconnectedAt = nil
        live.dormantSequence = nil
        state.controllers["controller-live"] = live
        _ = try SurfAceLocklessDormantRetention.reclaimOldest(in: &state)
        state.pendingControllerRetentionReclamations?[0].deliveredControllerInstanceIds = [
            "controller-impossible"
        ]
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        try encoder.encode(state).write(to: store.stateURL)

        XCTAssertThrowsError(try store.load()) { error in
            XCTAssertEqual(
                error as? SurfAceLocklessAuthorityError,
                .invalidState("controller_retention_reclamation_delivery:controller-reclamation:1")
            )
        }
    }

    func testReclamationCapturesExactLiveAndTombstoneUnreadDispositionBeforeDeletion() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        state.controllers["controller-dormant"] = dormantBundle(id: "controller-dormant", sequence: 1)
        var live = dormantBundle(id: "controller-live", sequence: 2)
        live.status = .live
        live.disconnectedAt = nil
        live.dormantSequence = nil
        state.controllers["controller-live"] = live

        let firstSurface = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let firstSurfaceScopeId = "surface:\(firstSurface.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? firstSurface)"
        _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state,
            scopeId: firstSurfaceScopeId,
            scopeKind: "surface",
            recordId: "discarded", recordClass: .content, payload: .string("discarded")
        )
        _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state,
            scopeId: firstSurfaceScopeId,
            scopeKind: "surface",
            recordId: "retained", recordClass: .content, payload: .string("retained")
        )
        state.scopes[firstSurfaceScopeId]?.cursors["controller-live"]?.cursor = 2
        let split = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: firstSurface, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        _ = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: firstSurface,
            paneId: try XCTUnwrap(split.newPaneIds.first), expectedTopologyRevision: 1
        )

        let secondSurface = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 1
        ).surface.surfaceId
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: secondSurface,
            expectedSurfaceSetRevision: 2, expectedTopologyRevision: 0
        )

        let occurrence = try XCTUnwrap(try SurfAceLocklessDormantRetention.reclaimOldest(
            in: &state, trigger: "test_pressure", reason: "byte_capacity"
        ))
        XCTAssertEqual(occurrence.scopeCount, 5)
        XCTAssertEqual(occurrence.cursorCount, 5)
        XCTAssertEqual(occurrence.liveCursorCount, 2)
        XCTAssertEqual(occurrence.tombstoneCursorCount, 3)
        XCTAssertEqual(occurrence.surfaceCursorCount, 2)
        XCTAssertEqual(occurrence.surfaceCount, 2)
        XCTAssertEqual(occurrence.tombstoneCount, 2)
        XCTAssertEqual(occurrence.unreadRecordCount, 2)
        XCTAssertEqual(occurrence.unreadRecordCountDiscarded, 1)
        XCTAssertGreaterThan(occurrence.cursorBytes, 0)
        XCTAssertGreaterThan(occurrence.liveCursorBytes, 0)
        XCTAssertGreaterThan(occurrence.tombstoneCursorBytes, 0)
        XCTAssertGreaterThan(occurrence.unreadBytes, occurrence.unreadBytesDiscarded)
        XCTAssertNil(state.controllers["controller-dormant"])
        XCTAssertNotNil(state.controllers["controller-live"])
        XCTAssertEqual(state.scopes[firstSurfaceScopeId]?.records.map(\.recordId), ["retained"])
        XCTAssertEqual(state.pendingControllerRetentionReclamations, [occurrence])
    }

    func testRollbackPreviewIsDeterministicAndDoesNotMutateAuthority() throws {
        var state = try SurfAceLocklessMigration.migrate(legacySnapshot())
        state.generation = 5
        state.controllers["controller-a"] = controllerBundle()
        state.targetApplyWorkItems["work-1"] = targetWork()
        let before = state

        let first = try SurfAceLocklessMigration.rollbackPreview(state)
        let second = try SurfAceLocklessMigration.rollbackPreview(state)

        XCTAssertEqual(state, before)
        XCTAssertEqual(first, second)
        XCTAssertEqual(first.sourceGeneration, 5)
        XCTAssertTrue(first.omissions.contains {
            $0.path == "/lockless/controllers/controller-a/pendingOperationReceipts/rq-1"
        })
        let projected = SurfAceLegacyUserDefaultsSnapshot(
            identityMapping: first.projection.identityMapping,
            surfaceTopologies: first.projection.surfaceTopologies
        )
        let migratedAgain = try SurfAceLocklessMigration.migrate(projected)
        XCTAssertEqual(migratedAgain.liveSurfaces["sf_1"]?.panes["7"]?.history.visible.contentId, "ct_00000001")
    }

    private func legacySnapshot() -> SurfAceLegacyUserDefaultsSnapshot {
        let entry: [String: Any] = [
            "contentId": "ct_00000001",
            "contentType": "markdown",
            "drawingData": "",
            "interactive": true,
            "payload": ["kind": "markdown", "markdown": "hello"],
            "provenanceDisplayName": "CLU",
            "revision": 4,
            "scrollable": true,
            "strokesById": [:],
        ]
        let older: [String: Any] = [
            "contentId": "ct_00000000",
            "contentType": "markdown",
            "drawingData": "",
            "interactive": true,
            "payload": ["kind": "markdown", "markdown": "older"],
            "revision": 3,
            "scrollable": true,
            "strokesById": [:],
        ]
        let newer: [String: Any] = [
            "contentId": "ct_00000002",
            "contentType": "markdown",
            "drawingData": "",
            "interactive": true,
            "payload": ["kind": "markdown", "markdown": "newer"],
            "revision": 5,
            "scrollable": true,
            "strokesById": [:],
        ]
        let identities: [String: Any] = [
            "surfacesBySceneKey": ["scene-1": ["surfaceId": "sf_1"]],
        ]
        let topologies: [String: Any] = [
            "sf_1": [
                "name": "Surf Ace",
                "paneLayout": ["kind": "leaf", "paneId": 7],
                "panes": [[
                    "annotationMode": true,
                    "backStack": [older],
                    "currentEntry": entry,
                    "currentTarget": ["targetId": "target-1", "targetEpoch": 2],
                    "forwardStack": [newer],
                    "name": "Notes",
                    "paneId": 7,
                    "paneLabel": 2,
                    "paneLineageId": "pl_7",
                ]],
                "windowLabel": "a",
            ],
        ]
        return SurfAceLegacyUserDefaultsSnapshot(
            identityMapping: try! JSONSerialization.data(withJSONObject: identities, options: [.sortedKeys]),
            surfaceTopologies: try! JSONSerialization.data(withJSONObject: topologies, options: [.sortedKeys])
        )
    }

    private func controllerBundle() -> SurfAceLocklessControllerBundle {
        var receipt = SurfAceLocklessOperationReceiptState(
            bytes: 0,
            commitSequence: 11,
            operation: "content.set",
            outcome: "resolved_success",
            requestId: "rq-1",
            status: .terminal,
            terminalResponse: .object(["ok": .bool(true)])
        )
        receipt.bytes = try! SurfAceLocklessExactDurableAccounting.receiptBytes(receipt)
        return SurfAceLocklessControllerBundle(
            controllerInstanceId: "controller-a",
            controllerProductName: "surf-ace",
            disconnectedAt: 1_785_619_273_922,
            dormantSequence: 3,
            pendingOperationReceipts: ["rq-1": receipt],
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            status: .dormant
        )
    }

    private func dormantBundle(id: String, sequence: Int64) -> SurfAceLocklessControllerBundle {
        SurfAceLocklessControllerBundle(
            controllerInstanceId: id,
            controllerProductName: nil,
            disconnectedAt: sequence * 10,
            dormantSequence: sequence,
            pendingOperationReceipts: [:],
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            status: .dormant
        )
    }

    private func retentionScope(controllerIds: [String]) -> SurfAceLocklessConsumableScope {
        var record = SurfAceLocklessConsumableRecord(
            bytes: 0,
            payload: .string("unread"),
            recordClass: .content,
            recordId: "record-1",
            sequence: 1
        )
        record.bytes = try! SurfAceLocklessConsumableOperations.restoredRecordBytes(record)
        return SurfAceLocklessConsumableScope(
            cursors: Dictionary(uniqueKeysWithValues: controllerIds.map {
                ($0, SurfAceLocklessConsumableCursor(cursor: 1, gap: nil, gapGeneration: 0))
            }),
            liveFrames: [:],
            nextSequence: 2,
            records: [record],
            scopeId: "surface:one",
            scopeKind: "surface"
        )
    }

    private func targetWork() -> SurfAceLocklessTargetWorkItem {
        var work = SurfAceLocklessTargetWorkItem(
            bytes: 0,
            controllerInstanceId: "controller-a",
            intentCommitSequence: 11,
            operationRequestId: "work-1",
            request: .object(["targetId": .string("target-1")]),
            state: .materializing,
            surfaceId: "sf_1",
            targetEpoch: 2,
            targetId: "target-1",
            targetRequestId: "target-rq-1"
        )
        work.bytes = try! SurfAceLocklessExactDurableAccounting.targetWorkBytes(work)
        return work
    }

    private func targetResult() -> SurfAceLocklessTargetResult {
        SurfAceLocklessTargetResult(
            consumableSequence: 1,
            errorCode: nil,
            intentCommitSequence: 11,
            materializedState: .object(["url": .string("https://example.com")]),
            operationRequestId: "rq-1",
            recordId: "record-1",
            status: "applied",
            surfaceId: "sf_1",
            targetEpoch: 2,
            targetId: "target-1",
            targetRequestId: "target-rq-1"
        )
    }

    private func surfaceTombstone(from surface: SurfAceLocklessSurfaceMaterial) -> SurfAceLocklessSurfaceTombstone {
        var tombstone = SurfAceLocklessSurfaceTombstone(
            bytes: 0,
            closedSequence: 4,
            scopes: [:],
            surface: surface,
            tombstoneId: "st_1"
        )
        tombstone.bytes = try! SurfAceLocklessTopologyOperations.restoredSurfaceTombstoneBytes(
            closedSequence: tombstone.closedSequence,
            scopes: tombstone.scopes,
            surface: tombstone.surface,
            tombstoneId: tombstone.tombstoneId
        )
        return tombstone
    }
}
