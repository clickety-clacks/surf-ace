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
        SurfAceLocklessControllerBundle(
            controllerInstanceId: "controller-a",
            controllerProductName: "surf-ace",
            disconnectedAt: 1_785_619_273_922,
            dormantSequence: 3,
            pendingOperationReceipts: [
                "rq-1": SurfAceLocklessOperationReceiptState(
                    bytes: 128,
                    commitSequence: 11,
                    operation: "content.set",
                    outcome: "resolved_success",
                    requestId: "rq-1",
                    status: .terminal,
                    terminalResponse: .object(["ok": .bool(true)])
                ),
            ],
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            status: .dormant
        )
    }

    private func targetWork() -> SurfAceLocklessTargetWorkItem {
        SurfAceLocklessTargetWorkItem(
            bytes: 256,
            controllerInstanceId: "controller-a",
            intentCommitSequence: 11,
            operationRequestId: "rq-1",
            request: .object(["targetId": .string("target-1")]),
            state: .materializing,
            surfaceId: "sf_1",
            targetEpoch: 2,
            targetId: "target-1",
            targetRequestId: "target-rq-1"
        )
    }

    private func targetResult() -> SurfAceLocklessTargetResult {
        SurfAceLocklessTargetResult(
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
        SurfAceLocklessSurfaceTombstone(
            bytes: 1_024,
            closedSequence: 4,
            scopes: [:],
            surface: surface,
            tombstoneId: "st_1"
        )
    }
}
