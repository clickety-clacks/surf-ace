import Foundation
import XCTest
@testable import SurfAce

final class SurfAceLocklessRuntimeAdapterTests: XCTestCase {
    func testRuntimeMapsCapacityErrorsToCanonicalCodesAndDetails() {
        XCTAssertEqual(
            SurfAceRuntime.locklessProtocolError(for: .receiptCapacity(
                currentBytes: 10,
                currentCount: 2,
                prospectiveBytes: 30,
                prospectiveCount: 3,
                maxBytes: 20,
                maxCount: 8
            )),
            SurfAceLocklessProtocolError(
                code: "receipt_capacity",
                details: [
                    "currentBytes": 10,
                    "currentCount": 2,
                    "maxBytes": 20,
                    "maxCount": 8,
                    "prospectiveBytes": 30,
                    "prospectiveCount": 3,
                ],
                message: "Pending operation receipt ledger is at capacity"
            )
        )
        XCTAssertEqual(
            SurfAceRuntime.locklessProtocolError(for: .surfaceStateCapacity(
                current: 100,
                prospective: 180,
                maximum: 150
            )),
            SurfAceLocklessProtocolError(
                code: "surface_state_capacity",
                details: [
                    "currentBytes": 100,
                    "maximumBytes": 150,
                    "prospectiveBytes": 180,
                ],
                message: "Target apply work item exceeds surface recoverable base capacity"
            )
        )
    }

    func testCanonicalTopologyCodecRejectsLegacyAuthorityAndRoundTripsCanonicalTree() throws {
        let canonical = try canonicalTopologyJSON(from: .split(
            direction: .horizontal,
            children: [.leaf(7, weight: 0.25), .leaf(9, weight: 0.75)],
            weight: 1
        ))
        XCTAssertEqual(canonical, .object([
            "children": .array([
                .object(["paneId": .integer(7), "type": .string("pane")]),
                .object(["paneId": .integer(9), "type": .string("pane")]),
            ]),
            "direction": .string("horizontal"),
            "type": .string("split"),
        ]))
        let projected = try persistedPaneLayout(fromCanonical: canonical)
        XCTAssertEqual(projected.runtimeNode.paneIDs, [7, 9])
        XCTAssertThrowsError(try persistedPaneLayout(fromCanonical: .object([
            "kind": .string("leaf"),
            "paneId": .integer(7),
        ])))
    }

    func testCompleteNativeTargetAdvertisesWithoutChangingLegacyRequestDetection() {
        XCTAssertTrue(SurfAceLocklessTargetAdmission.platformPermitsLockless)
        XCTAssertTrue(SurfAceLocklessTargetAdmission.implementationComplete)
        XCTAssertEqual(SurfAceLocklessTargetAdmission.unroutedNetworkOperations, [])
        XCTAssertEqual(SurfAceLocklessTargetAdmission.advertisedProtocolFeatures, [surfAceLocklessCapability])
        XCTAssertTrue(SurfAceLocklessTargetAdmission.isLocklessRequest([
            "protocolFeatures": [surfAceLocklessCapability],
        ]))
        XCTAssertFalse(SurfAceLocklessTargetAdmission.isLocklessRequest([
            "providerId": "legacy-provider",
        ]))
    }

    func testReadinessAndLocalMutationUseTheLoadedPersistentCoordinator() async throws {
        let fixture = try makeFixture()
        let before = await fixture.adapter.readinessSnapshot()
        XCTAssertTrue(before.fullGenerationLoaded)
        XCTAssertTrue(before.targetWorkRecovered)
        XCTAssertTrue(before.readyForAdmission)

        let commit = try await fixture.adapter.commitLocalMutation(operation: "local.resize") { state, sequence in
            state.surfaceSetRevision += 1
            return .integer(sequence)
        }
        XCTAssertEqual(commit.commitSequence, 1)
        XCTAssertEqual(commit.result, .integer(1))
        XCTAssertEqual(try fixture.store.load()?.surfaceSetRevision, 2)
        XCTAssertEqual(try fixture.store.load()?.sequences.nextCommitSequence, 2)
    }

    func testAdmissionRejectsDuplicateLiveIdentityThenResumesDormantBundle() async throws {
        let fixture = try makeFixture()
        let adapter = fixture.adapter
        let first = try await adapter.admit(
            controllerInstanceId: "controller-a",
            controllerProductName: "surf-ace",
            connectionToken: "connection-a",
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            protocolFeatures: [surfAceLocklessCapability]
        )
        XCTAssertFalse(first.resumed)

        await XCTAssertThrowsErrorAsync {
            _ = try await adapter.admit(
                controllerInstanceId: "controller-a",
                controllerProductName: "other-label",
                connectionToken: "connection-b",
                projectionCapacityBytes: 8 * 1_024 * 1_024,
                protocolFeatures: [surfAceLocklessCapability]
            )
        } verify: { error in
            XCTAssertEqual(error as? SurfAceLocklessRuntimeAdapterError, .duplicateLiveController)
        }

        try await adapter.disconnect(connectionToken: "connection-a", disconnectedAt: 10)
        let resumed = try await adapter.admit(
            controllerInstanceId: "controller-a",
            controllerProductName: "renamed",
            connectionToken: "connection-b",
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            protocolFeatures: [surfAceLocklessCapability]
        )
        XCTAssertTrue(resumed.resumed)
        XCTAssertEqual(resumed.state.controllers["controller-a"]?.status, .live)
        XCTAssertEqual(resumed.state.controllers["controller-a"]?.controllerProductName, "renamed")
    }

    func testAdmissionRequiresCapacityForRetainedWindowAndCursorState() async throws {
        let fixture = try makeFixture()
        let initial = try XCTUnwrap(fixture.store.load())
        let requiredCapacity = max(
            initial.limits.maxPaneConsumableBytes,
            initial.limits.maxSurfaceConsumableBytes
        ) + initial.limits.maxConsumableCursorStateBytesPerScope

        await XCTAssertThrowsErrorAsync {
            _ = try await fixture.adapter.admit(
                controllerInstanceId: "controller-too-small",
                controllerProductName: "surf-ace",
                connectionToken: "connection-too-small",
                projectionCapacityBytes: requiredCapacity - 1,
                protocolFeatures: [surfAceLocklessCapability],
                surfaceId: "sf_1"
            )
        } verify: { error in
            XCTAssertEqual(error as? SurfAceLocklessRuntimeAdapterError, .capabilityMismatch)
        }
        let rejected = try XCTUnwrap(fixture.store.load())
        XCTAssertNil(rejected.controllers["controller-too-small"])
        XCTAssertNil(rejected.negotiatedModes["sf_1"])

        let admitted = try await fixture.adapter.admit(
            controllerInstanceId: "controller-exact",
            controllerProductName: "surf-ace",
            connectionToken: "connection-exact",
            projectionCapacityBytes: requiredCapacity,
            protocolFeatures: [surfAceLocklessCapability],
            surfaceId: "sf_1"
        )
        XCTAssertEqual(
            admitted.state.controllers["controller-exact"]?.projectionCapacityBytes,
            requiredCapacity
        )
        XCTAssertEqual(admitted.state.negotiatedModes["sf_1"], .lockless)
    }

    func testResumeAppliesPendingAcknowledgementsAndResolvesExactReceipts() async throws {
        let fixture = try makeFixture()
        let adapter = fixture.adapter
        _ = try await adapter.admit(
            controllerInstanceId: "controller-a",
            controllerProductName: "surf-ace",
            connectionToken: "connection-a",
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            protocolFeatures: [surfAceLocklessCapability],
            surfaceId: "sf_1"
        )
        let committed = try await adapter.commitMutation(
            connectionToken: "connection-a", requestId: "request-1", operation: "content.set"
        ) { _, sequence in
            .object([
                "operationReceipt": .object([
                    "commitSequence": .integer(sequence), "requestId": .string("request-1"),
                ]),
                "status": .string("accepted"),
            ])
        }
        try await adapter.disconnect(connectionToken: "connection-a", disconnectedAt: 10)

        let resumed = try await adapter.admit(
            controllerInstanceId: "controller-a",
            controllerProductName: "surf-ace",
            connectionToken: "connection-b",
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            protocolFeatures: [surfAceLocklessCapability],
            surfaceId: "sf_1",
            pendingAcks: [.init(cursor: 1, gapGeneration: nil, scopeId: "surface:sf_1")],
            unresolvedRequestIds: ["request-1", "request-missing"]
        )

        XCTAssertTrue(resumed.resumed)
        XCTAssertEqual(resumed.receiptResolutions, [
            .object([
                "operationReceipt": .object([
                    "commitSequence": .integer(committed.commitSequence),
                    "requestId": .string("request-1"),
                ]),
                "outcome": .string("resolved_success"),
                "requestId": .string("request-1"),
                "terminalResponse": committed.terminalResponse,
            ]),
            .object(["outcome": .string("not_committed"), "requestId": .string("request-missing")]),
        ])
        XCTAssertEqual(
            resumed.state.scopes["surface:sf_1"]?.cursors["controller-a"]?.cursor, 1
        )
    }

    func testNegotiatedSurfaceModePersistsAndRejectsMixedModeAdmission() async throws {
        let lockless = try makeFixture()
        _ = try await lockless.adapter.admit(
            controllerInstanceId: "controller-a",
            controllerProductName: nil,
            connectionToken: "connection-a",
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            protocolFeatures: [surfAceLocklessCapability],
            surfaceId: "sf_1"
        )
        XCTAssertEqual(try lockless.store.load()?.negotiatedModes["sf_1"], .lockless)
        await XCTAssertThrowsErrorAsync {
            _ = try await lockless.adapter.negotiateLegacySurface("sf_1")
        } verify: { error in
            XCTAssertEqual(error as? SurfAceLocklessRuntimeAdapterError, .capabilityMismatch)
        }

        let legacy = try makeFixture()
        _ = try await legacy.adapter.negotiateLegacySurface("sf_1")
        XCTAssertEqual(try legacy.store.load()?.negotiatedModes["sf_1"], .legacy)
        await XCTAssertThrowsErrorAsync {
            _ = try await legacy.adapter.admit(
                controllerInstanceId: "controller-a",
                controllerProductName: nil,
                connectionToken: "connection-a",
                projectionCapacityBytes: 8 * 1_024 * 1_024,
                protocolFeatures: [surfAceLocklessCapability],
                surfaceId: "sf_1"
            )
        } verify: { error in
            XCTAssertEqual(error as? SurfAceLocklessRuntimeAdapterError, .capabilityMismatch)
        }
    }

    func testDormantCountPressureReclaimsOldestAndReadmissionStartsAtCurrentTail() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceLocklessDormantCountTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        state.limits.maxDormantControllerEntries = 1
        state.scopes["surface:one"] = SurfAceLocklessConsumableScope(
            cursors: [:], liveFrames: [:], nextSequence: 1, records: [],
            scopeId: "surface:one", scopeKind: "surface"
        )
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(
            store: store,
            legacy: SurfAceLegacyUserDefaultsSnapshot(identityMapping: nil, surfaceTopologies: nil)
        )

        _ = try await admit(adapter, id: "controller-z", token: "connection-z")
        _ = try await adapter.commitMutation(
            connectionToken: "connection-z",
            requestId: "request-z",
            operation: "content.set"
        ) { _, _ in .string("controller-z-committed") }
        try await adapter.disconnect(connectionToken: "connection-z", disconnectedAt: 10)
        _ = try await admit(adapter, id: "controller-a", token: "connection-a")
        _ = try await adapter.commitMutation(
            connectionToken: "connection-a",
            requestId: "request-a",
            operation: "content.set",
            consumableScopeId: "surface:one",
            consumableScopeKind: "surface",
            consumableRecordClass: .content
        ) { _, _ in .string("committed") }
        try await adapter.disconnect(connectionToken: "connection-a", disconnectedAt: 20)

        let reclaimed = await adapter.snapshot()
        XCTAssertNil(reclaimed.controllers["controller-z"])
        XCTAssertEqual(reclaimed.controllers["controller-a"]?.dormantSequence, 2)
        XCTAssertNil(reclaimed.scopes["surface:one"]?.cursors["controller-z"])
        let readmitted = try await adapter.admit(
            controllerInstanceId: "controller-z",
            controllerProductName: nil,
            connectionToken: "connection-z-2",
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            protocolFeatures: [surfAceLocklessCapability],
            unresolvedRequestIds: ["request-z"]
        )
        XCTAssertFalse(readmitted.resumed)
        XCTAssertEqual(readmitted.receiptResolutions, [.object([
            "cause": .string("controller_reclaimed"),
            "outcome": .string("receipt_unavailable"),
            "requestId": .string("request-z"),
        ])])
        XCTAssertEqual(readmitted.state.scopes["surface:one"]?.cursors["controller-z"]?.cursor, 2)
    }

    func testDisconnectOverDormantByteBoundReclaimsWithoutRejectingTransition() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceLocklessDisconnectByteTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        state.limits.maxDormantControllerBytes = 1
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(
            store: store,
            legacy: SurfAceLegacyUserDefaultsSnapshot(identityMapping: nil, surfaceTopologies: nil)
        )

        _ = try await admit(adapter, id: "controller-a", token: "connection-a")
        try await adapter.disconnect(connectionToken: "connection-a", disconnectedAt: 10)

        let after = await adapter.snapshot()
        XCTAssertTrue(after.controllers.isEmpty)
        XCTAssertLessThanOrEqual(
            try SurfAceLocklessDormantRetention.usage(in: after).bytes,
            after.limits.maxDormantControllerBytes
        )
    }

    func testRestartDormancyBytePressureReclaimsBySequenceNotIdentity() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceLocklessDormantByteTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        state.controllers = [
            "controller-z": liveBundle(id: "controller-z"),
            "controller-a": liveBundle(id: "controller-a"),
        ]
        state.scopes["surface:one"] = SurfAceLocklessConsumableScope(
            cursors: [
                "controller-z": .init(cursor: 1, gap: nil, gapGeneration: 0),
                "controller-a": .init(cursor: 1, gap: nil, gapGeneration: 0),
            ],
            liveFrames: [:], nextSequence: 1, records: [],
            scopeId: "surface:one", scopeKind: "surface"
        )
        var measured = state
        measured.controllers["controller-a"]?.status = .dormant
        measured.controllers["controller-a"]?.dormantSequence = 1
        measured.controllers["controller-a"]?.disconnectedAt = 1
        measured.controllers["controller-z"]?.status = .dormant
        measured.controllers["controller-z"]?.dormantSequence = 2
        measured.controllers["controller-z"]?.disconnectedAt = 2
        let usage = try SurfAceLocklessDormantRetention.usage(in: measured)
        state.limits.maxDormantControllerBytes = try XCTUnwrap(usage.bytesByController["controller-z"])
        try store.save(state)

        _ = try SurfAceLocklessRuntimeAdapter(
            store: store,
            legacy: SurfAceLegacyUserDefaultsSnapshot(identityMapping: nil, surfaceTopologies: nil)
        )
        let restored = try XCTUnwrap(store.load())
        XCTAssertNil(restored.controllers["controller-a"])
        XCTAssertEqual(restored.controllers["controller-z"]?.status, .dormant)
        XCTAssertEqual(restored.controllers["controller-z"]?.dormantSequence, 2)
    }

    func testMutationPersistsExactReceiptBeforeFanoutAndAckRemovesIt() async throws {
        let fixture = try makeFixture()
        let adapter = fixture.adapter
        _ = try await adapter.admit(
            controllerInstanceId: "controller-a",
            controllerProductName: nil,
            connectionToken: "connection-a",
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            protocolFeatures: [surfAceLocklessCapability]
        )

        let committed = try await adapter.commitMutation(
            connectionToken: "connection-a",
            requestId: "request-1",
            operation: "content.set"
        ) { state, sequence in
            state.surfaceSetRevision += 1
            return .object([
                "commitSequence": .integer(sequence),
                "ok": .bool(true),
            ])
        }
        let stored = try XCTUnwrap(fixture.store.load())
        XCTAssertEqual(stored.surfaceSetRevision, 2)
        XCTAssertEqual(
            stored.controllers["controller-a"]?.pendingOperationReceipts["request-1"]?.terminalResponse,
            committed.terminalResponse
        )

        let fanout = await adapter.fanout(afterCommitted: .object(["event": .string("committed")]))
        XCTAssertEqual(fanout.connectionTokens, ["connection-a"])
        let resolutions = try await adapter.resolveReceipts(
            connectionToken: "connection-a",
            requestIds: ["request-1", "request-missing"]
        )
        XCTAssertEqual(resolutions.count, 2)
        XCTAssertEqual(resolutions[1], .object([
            "outcome": .string("not_committed"),
            "requestId": .string("request-missing"),
        ]))

        try await adapter.acknowledgeReceipts(
            connectionToken: "connection-a",
            requestIds: ["request-1"]
        )
        XCTAssertNil(try fixture.store.load()?.controllers["controller-a"]?.pendingOperationReceipts["request-1"])
    }

    func testReceiptCapacityRefusalCommitsNoMutationOrSequence() async throws {
        let fixture = try makeFixture { state in
            state.limits.maxPendingOperationReceiptBytesPerController = 1
        }
        _ = try await admit(fixture.adapter, id: "controller-a", token: "connection-a")
        let before = await fixture.adapter.snapshot()

        await XCTAssertThrowsErrorAsync {
            _ = try await fixture.adapter.commitMutation(
                connectionToken: "connection-a",
                requestId: "request-capacity",
                operation: "content.set"
            ) { state, _ in
                state.surfaceSetRevision += 1
                return .object(["status": .string("accepted")])
            }
        } verify: { error in
            guard case .receiptCapacity(
                let currentBytes,
                let currentCount,
                let prospectiveBytes,
                let prospectiveCount,
                let maxBytes,
                let maxCount
            ) = error as? SurfAceLocklessRuntimeAdapterError else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(currentBytes, 0)
            XCTAssertEqual(currentCount, 0)
            XCTAssertGreaterThan(prospectiveBytes, maxBytes)
            XCTAssertEqual(prospectiveCount, 1)
            XCTAssertEqual(maxCount, SurfAceLocklessCapacityLimits.production.maxPendingOperationReceiptsPerController)
        }

        let after = await fixture.adapter.snapshot()
        XCTAssertEqual(after.generation, before.generation)
        XCTAssertEqual(after.surfaceSetRevision, before.surfaceSetRevision)
        XCTAssertEqual(after.sequences.nextCommitSequence, before.sequences.nextCommitSequence)
        XCTAssertNil(after.controllers["controller-a"]?.pendingOperationReceipts["request-capacity"])
    }

    func testTargetWorkCapacityRefusalIsTypedAndSideEffectFree() async throws {
        let request: SurfAceLocklessJSON = .object(["url": .string("https://example.com")])
        let fixture = try makeFixture { state in
            let surface = try XCTUnwrap(state.liveSurfaces["sf_1"])
            var work = SurfAceLocklessTargetWorkItem(
                bytes: 0,
                controllerInstanceId: "controller-a",
                intentCommitSequence: state.sequences.nextCommitSequence,
                operationRequestId: "operation-capacity",
                request: request,
                state: .intentCommitted,
                surfaceId: "sf_1",
                targetEpoch: 2,
                targetId: "target-1",
                targetRequestId: "target-request-1"
            )
            work.bytes = try SurfAceLocklessExactDurableAccounting.targetWorkBytes(work)
            state.limits.maxSurfaceRecoverableBaseBytes =
                try SurfAceLocklessTopologyOperations.surfaceBaseBytes(surface) + work.bytes - 1
        }
        _ = try await admit(fixture.adapter, id: "controller-a", token: "connection-a")
        let before = await fixture.adapter.snapshot()

        await XCTAssertThrowsErrorAsync {
            _ = try await fixture.adapter.commitTargetIntent(
                connectionToken: "connection-a",
                operationRequestId: "operation-capacity",
                targetRequestId: "target-request-1",
                surfaceId: "sf_1",
                targetId: "target-1",
                targetEpoch: 2,
                request: request
            )
        } verify: { error in
            guard case .surfaceStateCapacity(let current, let prospective, let maximum) =
                    error as? SurfAceLocklessRuntimeAdapterError else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertLessThanOrEqual(current, maximum)
            XCTAssertGreaterThan(prospective, maximum)
        }

        let after = await fixture.adapter.snapshot()
        XCTAssertEqual(after.generation, before.generation)
        XCTAssertEqual(after.sequences.nextCommitSequence, before.sequences.nextCommitSequence)
        XCTAssertNil(after.targetApplyWorkItems["operation-capacity"])
        XCTAssertNil(after.controllers["controller-a"]?.pendingOperationReceipts["operation-capacity"])
    }

    func testTargetIntentAndMaterializingAreDurableBeforeExternalWork() async throws {
        let fixture = try makeFixture()
        let adapter = fixture.adapter
        _ = try await adapter.admit(
            controllerInstanceId: "controller-a",
            controllerProductName: nil,
            connectionToken: "connection-a",
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            protocolFeatures: [surfAceLocklessCapability]
        )
        _ = try await adapter.commitTargetIntent(
            connectionToken: "connection-a",
            operationRequestId: "operation-1",
            targetRequestId: "target-request-1",
            surfaceId: "sf_1",
            targetId: "target-1",
            targetEpoch: 2,
            request: .object([
                "paneId": .integer(1),
                "url": .string("https://example.com"),
            ])
        )
        XCTAssertEqual(
            try fixture.store.load()?.targetApplyWorkItems["operation-1"]?.state,
            .intentCommitted
        )

        let result = try await adapter.materializeTargetWork(operationRequestId: "operation-1") { _ in
            XCTAssertEqual(
                try? fixture.store.load()?.targetApplyWorkItems["operation-1"]?.state,
                .materializing
            )
            return SurfAceLocklessMaterializationOutcome(
                errorCode: nil,
                materializedState: .object(["url": .string("https://example.com")]),
                status: "applied"
            )
        }
        XCTAssertEqual(result.status, "applied")
        XCTAssertNil(try fixture.store.load()?.targetApplyWorkItems["operation-1"])
        XCTAssertEqual(try fixture.store.load()?.targetApplyResults["operation-1"], result)
    }

    private func makeFixture(
        configure: (inout SurfAceLocklessAuthorityState) throws -> Void = { _ in }
    ) throws -> (
        adapter: SurfAceLocklessRuntimeAdapter,
        store: SurfAceLocklessGenerationStore
    ) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceLocklessRuntimeAdapterTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state,
            expectedSurfaceSetRevision: 0
        )
        let originalId = opened.surface.surfaceId
        var surface = opened.surface
        surface.surfaceId = "sf_1"
        state.liveSurfaces.removeValue(forKey: originalId)
        state.liveSurfaces["sf_1"] = surface
        let originalSurfaceScope = "surface:\(originalId)"
        if var scope = state.scopes.removeValue(forKey: originalSurfaceScope) {
            scope.scopeId = "surface:sf_1"
            state.scopes[scope.scopeId] = scope
        }
        let originalPaneScope = "pane:\(originalId):1"
        if var scope = state.scopes.removeValue(forKey: originalPaneScope) {
            scope.scopeId = "pane:sf_1:1"
            state.scopes[scope.scopeId] = scope
        }
        try configure(&state)
        try store.save(state)
        let legacy = SurfAceLegacyUserDefaultsSnapshot(identityMapping: nil, surfaceTopologies: nil)
        return (try SurfAceLocklessRuntimeAdapter(store: store, legacy: legacy), store)
    }

    private func admit(
        _ adapter: SurfAceLocklessRuntimeAdapter,
        id: String,
        token: String
    ) async throws -> SurfAceLocklessAdmissionResult {
        try await adapter.admit(
            controllerInstanceId: id,
            controllerProductName: nil,
            connectionToken: token,
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            protocolFeatures: [surfAceLocklessCapability]
        )
    }

    private func liveBundle(id: String) -> SurfAceLocklessControllerBundle {
        SurfAceLocklessControllerBundle(
            controllerInstanceId: id,
            controllerProductName: nil,
            disconnectedAt: nil,
            dormantSequence: nil,
            pendingOperationReceipts: [:],
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            status: .live
        )
    }
}

private func XCTAssertThrowsErrorAsync(
    _ expression: () async throws -> Void,
    verify: (Error) -> Void
) async {
    do {
        try await expression()
        XCTFail("expected error")
    } catch {
        verify(error)
    }
}
