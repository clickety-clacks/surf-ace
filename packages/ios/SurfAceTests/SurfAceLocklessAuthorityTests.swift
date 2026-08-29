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
        let work = targetWork()
        let result = targetResult()
        state.targetApplyWorkItems[work.identity.storageKey] = work
        state.targetApplyResults[result.identity.storageKey] = result
        var closedSurface = try XCTUnwrap(state.liveSurfaces["sf_1"])
        closedSurface.surfaceId = "sf_2"
        closedSurface.sceneKeys = []
        state.surfaceTombstones = [surfaceTombstone(from: closedSurface)]

        try store.save(state)
        let restored = try XCTUnwrap(store.load())

        XCTAssertEqual(restored, state)
        XCTAssertEqual(restored.controllers["controller-a"]?.pendingOperationReceipts["rq-1"]?.commitSequence, 11)
        XCTAssertEqual(restored.targetApplyWorkItems[work.identity.storageKey]?.state, .materializing)
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
        let work = targetWork()
        state.targetApplyWorkItems[work.identity.storageKey] = work
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
            "provenanceDisplayName": "OpenClaw",
            "senderDisplayName": "Clawline",
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
            controllerInstanceId: "controller-a",
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

extension SurfAceLocklessAuthorityTests {
    func testACCLOSE07ValidCloseAtExactBoundAndFourStandaloneTransitionsAreAtomic() throws {
        for reversed in [false, true] {
            var closeState = try closeAtExactTombstoneBound(reversedIdentities: reversed)
            let beforeClose = closeState
            let surface = try XCTUnwrap(closeState.liveSurfaces.values.first)
            let close = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
                state: &closeState,
                surfaceId: surface.surfaceId,
                expectedSurfaceSetRevision: closeState.surfaceSetRevision,
                expectedTopologyRevision: surface.topologyRevision
            )
            let retained = try XCTUnwrap(
                closeState.surfaceTombstones.first(where: { $0.tombstoneId == close.tombstoneId })
            )
            XCTAssertEqual(retained.bytes, beforeClose.limits.maxRecoverableSurfaceBytes)
            XCTAssertEqual(retained.bytes, beforeClose.limits.maxRetainedTombstoneBytes)
            XCTAssertEqual(retained.surface, beforeClose.liveSurfaces[surface.surfaceId])

            let equality = try retainedAggregateTransitionState(reversedIdentities: reversed)
            let exactAggregate = equality.surfaceTombstones.reduce(Int64(0)) { $0 + $1.bytes }
            XCTAssertEqual(exactAggregate, equality.limits.maxRetainedTombstoneBytes)
            let equalitySource = equality
            for transition in [
                SurfAceLocklessRecoverableTransition.locklessAdmission,
                .legacyMigration, .restart, .configuration,
            ] {
                XCTAssertEqual(try equality.validated(for: transition), equality)
                XCTAssertEqual(equality, equalitySource)
            }

            var overLimits = equality.limits
            overLimits.maxRetainedTombstoneBytes = exactAggregate - 1
            XCTAssertGreaterThanOrEqual(
                overLimits.maxRetainedTombstoneBytes,
                overLimits.maxRecoverableSurfaceBytes
            )
            let priorGeneration = equality
            for transition in [
                SurfAceLocklessRecoverableTransition.locklessAdmission,
                .legacyMigration, .restart, .configuration,
            ] {
                XCTAssertThrowsError(try equality.validated(for: transition, limits: overLimits)) { error in
                    XCTAssertEqual(
                        error as? SurfAceLocklessTopologyOperationError,
                        .tombstoneCapacity(bytes: exactAggregate, maximum: exactAggregate - 1)
                    )
                }
                XCTAssertEqual(equality, priorGeneration)
            }
        }

        let normal = try retainedAggregateTransitionState(reversedIdentities: false)
        let reversed = try retainedAggregateTransitionState(reversedIdentities: true)
        XCTAssertEqual(normal.surfaceTombstones.map(\.bytes), reversed.surfaceTombstones.map(\.bytes))
    }

    func testACMIG02OverPPreservedStateMigratesWithoutClampAndTrueCombinedOverflowRejects() throws {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxPanesPerSurface = 2
        limits.maxRetainedTombstones = 3
        let valid = try legacySnapshotWithPaneCount(3)
        let migrated = try SurfAceLocklessMigration.migrate(valid, limits: limits)
        XCTAssertEqual(migrated.liveSurfaces["sf_1"]?.panes.count, 3)
        XCTAssertEqual(migrated.liveSurfaces["sf_1"]?.panes.keys.sorted(), ["7", "8", "9"])
        let before = migrated
        var refusal = migrated
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.paneSplit(
            state: &refusal, surfaceId: "sf_1", paneId: 7, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )) { error in
            XCTAssertEqual(
                error as? SurfAceLocklessTopologyOperationError,
                .paneCapacity(current: 3, requested: 4, maximum: 2)
            )
        }
        XCTAssertEqual(refusal, before)
        XCTAssertThrowsError(try SurfAceLocklessMigration.migrate(
            legacySnapshotWithPaneCount(6), limits: limits
        )) { error in
            XCTAssertTrue(
                error is SurfAceLocklessAuthorityError || error is SurfAceLocklessMigrationError,
                "unexpected migration failure \(error)"
            )
        }
    }

    func testACCAP03AndACOPS01ExactOverPGenerationRestoresBeforeAdmission() async throws {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxPanesPerSurface = 2
        limits.maxRetainedTombstones = 3
        var state = try SurfAceLocklessMigration.migrate(
            legacySnapshotWithPaneCount(3), limits: limits
        )
        state.controllers["live"] = SurfAceLocklessControllerBundle(
            controllerInstanceId: "live", controllerProductName: "A", disconnectedAt: nil,
            dormantSequence: nil, pendingOperationReceipts: [:], projectionCapacityBytes: 8_388_608,
            status: .live
        )
        state.controllers["dormant"] = SurfAceLocklessControllerBundle(
            controllerInstanceId: "dormant", controllerProductName: "B", disconnectedAt: 10,
            dormantSequence: 1, pendingOperationReceipts: [:], projectionCapacityBytes: 8_388_608,
            status: .dormant
        )
        state.sequences.nextDormantSequence = 2
        SurfAceLocklessConsumableOperations.admitController("live", in: &state)
        SurfAceLocklessConsumableOperations.admitController("dormant", in: &state)
        XCTAssertEqual(limits.recoverableSurfaceMinimumBytes,
            limits.maxSurfaceRecoverableBaseBytes
                + limits.maxSurfaceConsumableBytes
                + limits.maxAdmittedControllerEntries * limits.maxConsumableCursorStateBytesPerScope
                + (limits.maxPanesPerSurface + limits.maxRetainedTombstones)
                    * (limits.maxPaneRecoverableStateBytes + limits.maxPaneConsumableBytes
                        + limits.maxAdmittedControllerEntries * limits.maxConsumableCursorStateBytesPerScope)
        )
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ACOPS01-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(
            store: store, legacy: .init(identityMapping: nil, surfaceTopologies: nil)
        )
        let readiness = await adapter.readinessSnapshot()
        XCTAssertTrue(readiness.fullGenerationLoaded)
        XCTAssertTrue(readiness.readyForAdmission)
        XCTAssertEqual(readiness.state.liveSurfaces["sf_1"]?.panes.count, 3)
        XCTAssertEqual(readiness.state.limits, limits)
        XCTAssertEqual(readiness.state.controllers.keys.sorted(), ["dormant", "live"])
        XCTAssertTrue(readiness.state.controllers.values.allSatisfy { $0.status == .dormant })
    }

    func testRollbackProjectionPreservesBothCompositeProvenanceComponents() throws {
        let state = try SurfAceLocklessMigration.migrate(legacySnapshot())
        let preview = try SurfAceLocklessMigration.rollbackPreview(state)
        let root = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: preview.projection.surfaceTopologies) as? [String: Any]
        )
        let surface = try XCTUnwrap(root["sf_1"] as? [String: Any])
        let panes = try XCTUnwrap(surface["panes"] as? [[String: Any]])
        let current = try XCTUnwrap(panes.first?["currentEntry"] as? [String: Any])
        XCTAssertEqual(current["provenanceDisplayName"] as? String, "OpenClaw")
        XCTAssertEqual(current["senderDisplayName"] as? String, "Clawline")
    }

    private func legacySnapshotWithPaneCount(_ count: Int) throws -> SurfAceLegacyUserDefaultsSnapshot {
        let source = legacySnapshot()
        var root = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: XCTUnwrap(source.surfaceTopologies)) as? [String: Any]
        )
        var surface = try XCTUnwrap(root["sf_1"] as? [String: Any])
        let template = try XCTUnwrap((surface["panes"] as? [[String: Any]])?.first)
        var panes: [[String: Any]] = []
        var leaves: [[String: Any]] = []
        for index in 0..<count {
            var pane = template
            pane["paneId"] = 7 + index
            pane["paneLabel"] = 2 + index
            pane["paneLineageId"] = "pl_\(7 + index)"
            panes.append(pane)
            leaves.append(["kind": "leaf", "paneId": 7 + index, "weight": 1.0 / Double(count)])
        }
        surface["panes"] = panes
        surface["paneLayout"] = count == 1
            ? leaves[0]
            : ["kind": "split", "direction": "horizontal", "children": leaves]
        root["sf_1"] = surface
        return SurfAceLegacyUserDefaultsSnapshot(
            identityMapping: source.identityMapping,
            surfaceTopologies: try JSONSerialization.data(withJSONObject: root, options: [.sortedKeys])
        )
    }

    private func retainedAggregateTransitionState(
        reversedIdentities: Bool
    ) throws -> SurfAceLocklessAuthorityState {
        var state = try SurfAceLocklessAuthorityState.empty()
        for index in 0..<2 {
            let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
                state: &state, expectedSurfaceSetRevision: state.surfaceSetRevision
            )
            _ = try SurfAceLocklessTopologyOperations.paneSplit(
                state: &state, surfaceId: opened.surface.surfaceId, paneId: 1, count: 3,
                direction: "horizontal", expectedTopologyRevision: 0
            )
            try applyEqualWidthIdentity(
                to: &state, surfaceId: opened.surface.surfaceId,
                reversed: reversedIdentities != (index == 0)
            )
            _ = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
                state: &state, surfaceId: opened.surface.surfaceId,
                expectedSurfaceSetRevision: state.surfaceSetRevision,
                expectedTopologyRevision: 1
            )
        }
        var limits = try exactSmallLimits(for: state)
        let aggregate = state.surfaceTombstones.reduce(Int64(0)) { $0 + $1.bytes }
        limits.maxRetainedTombstoneBytes = aggregate
        limits.maxRecoverableSurfaceBytes = max(
            limits.recoverableSurfaceMinimumBytes,
            state.surfaceTombstones.map(\.bytes).max() ?? 1
        )
        XCTAssertLessThanOrEqual(limits.maxRecoverableSurfaceBytes, aggregate)
        state.limits = limits
        return try state.validated(for: .configuration)
    }

    private func closeAtExactTombstoneBound(
        reversedIdentities: Bool
    ) throws -> SurfAceLocklessAuthorityState {
        var state = try SurfAceLocklessAuthorityState.empty()
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        )
        let split = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: opened.surface.surfaceId, paneId: 1, count: 3,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        _ = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: opened.surface.surfaceId,
            paneId: split.newPaneIds[0], expectedTopologyRevision: 1
        )
        _ = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: opened.surface.surfaceId,
            paneId: split.newPaneIds[1], expectedTopologyRevision: 2
        )
        _ = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: opened.surface.surfaceId, paneId: 1, count: 3,
            direction: "vertical", expectedTopologyRevision: 3
        )
        try applyEqualWidthIdentity(
            to: &state, surfaceId: opened.surface.surfaceId, reversed: reversedIdentities
        )
        let surface = try XCTUnwrap(state.liveSurfaces[opened.surface.surfaceId])
        let sequence = state.sequences.nextClosedSequence
        let tombstoneId = String(format: "st_%016llx", sequence)
        let scopes = Dictionary(uniqueKeysWithValues: state.scopes.filter {
            $0.key.hasPrefix("surface:") || $0.key.hasPrefix("pane:")
        })
        let exact = try SurfAceLocklessTopologyOperations.restoredSurfaceTombstoneBytes(
            closedSequence: sequence, scopes: scopes, surface: surface, tombstoneId: tombstoneId
        )
        var limits = try exactSmallLimits(for: state)
        limits.maxRetainedTombstoneBytes = exact
        limits.maxRecoverableSurfaceBytes = exact
        XCTAssertLessThanOrEqual(limits.recoverableSurfaceMinimumBytes, exact)
        state.limits = limits
        return try state.validated(for: .configuration)
    }

    private func exactSmallLimits(
        for state: SurfAceLocklessAuthorityState
    ) throws -> SurfAceLocklessCapacityLimits {
        let surfaces = Array(state.liveSurfaces.values) + state.surfaceTombstones.map(\.surface)
        let panes = surfaces.flatMap { Array($0.panes.values) + $0.paneTombstones.map(\.pane) }
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxPanesPerSurface = 3
        limits.maxRetainedTombstones = 2
        limits.maxPaneRecoverableStateBytes = try panes.map {
            try SurfAceLocklessContentOperations.exactPaneRecoverableBytes($0)
        }.max() ?? 1
        limits.maxPaneAnnotationRestoreBytes = try panes.map {
            try SurfAceLocklessContentOperations.exactAnnotationRestoreBytes($0)
        }.max() ?? 1
        limits.maxSurfaceRecoverableBaseBytes = try surfaces.map {
            try SurfAceLocklessTopologyOperations.surfaceBaseBytes($0)
        }.max() ?? 1
        limits.maxPaneConsumableRecords = 1
        limits.maxPaneConsumableBytes = 1
        limits.maxSurfaceConsumableRecords = 1
        limits.maxSurfaceConsumableBytes = 1
        limits.maxConsumableRecordBytes = 1
        limits.maxConsumableCursorStateBytesPerScope = 1
        limits.maxAdmittedControllerEntries = 1
        limits.maxDormantControllerEntries = 1
        limits.maxRecoverableSurfaceBytes = limits.recoverableSurfaceMinimumBytes
        limits.maxRetainedTombstoneBytes = limits.maxRecoverableSurfaceBytes
        return limits
    }

    private func applyEqualWidthIdentity(
        to state: inout SurfAceLocklessAuthorityState,
        surfaceId: String,
        reversed: Bool
    ) throws {
        var surface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        let chat = reversed ? "Controller-B" : "Controller-A"
        let product = reversed ? "Product-B" : "Product-A"
        for key in surface.panes.keys {
            surface.panes[key]?.history.visible.provenance = .init(
                friendlyChatName: chat, controllerProductName: product
            )
        }
        for index in surface.paneTombstones.indices {
            surface.paneTombstones[index].pane.history.visible.provenance = .init(
                friendlyChatName: chat, controllerProductName: product
            )
            let tombstone = surface.paneTombstones[index]
            surface.paneTombstones[index].bytes = try SurfAceLocklessTopologyOperations
                .restoredPaneTombstoneBytes(
                    closedSequence: tombstone.closedSequence,
                    pane: surface.paneTombstones[index].pane,
                    scope: tombstone.scope,
                    tombstoneId: tombstone.tombstoneId
                )
        }
        state.liveSurfaces[surfaceId] = surface
    }

}
