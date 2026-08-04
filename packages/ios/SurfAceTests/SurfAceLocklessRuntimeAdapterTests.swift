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

    func testAdmissionCapacityReclamationRecordsExactTriggerAndReason() async throws {
        let fixture = try makeFixture { state in
            state.limits.maxAdmittedControllerEntries = 2
        }
        _ = try await admit(fixture.adapter, id: "controller-a", token: "connection-a")
        _ = try await admit(fixture.adapter, id: "controller-b", token: "connection-b")
        try await fixture.adapter.disconnect(connectionToken: "connection-a", disconnectedAt: 9)
        _ = try await admit(fixture.adapter, id: "controller-c", token: "connection-c")

        let occurrence = try XCTUnwrap(
            fixture.store.load()?.pendingControllerRetentionReclamations?.last
        )
        XCTAssertEqual(occurrence.controllerInstanceId, "controller-a")
        XCTAssertEqual(occurrence.trigger, "controller_admission")
        XCTAssertEqual(occurrence.reason, "entry_capacity")
        XCTAssertEqual(try fixture.store.load()?.controllers.keys.sorted(), ["controller-b", "controller-c"])
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
            pendingAcks: [.init(cursor: 1, gapGeneration: nil, scopeId: "surface:sf%5F1")],
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
            resumed.state.scopes["surface:sf%5F1"]?.cursors["controller-a"]?.cursor, 1
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
        XCTAssertEqual(
            restored.pendingControllerRetentionReclamations?.first?.trigger,
            "restored_state_enforcement"
        )
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
        guard case .object(let terminal) = committed.terminalResponse else {
            return XCTFail("expected full success response")
        }
        XCTAssertEqual(terminal["id"], .string("request-1"))
        XCTAssertEqual(terminal["ok"], .bool(true))
        XCTAssertEqual(terminal["payload"], committed.responsePayload)
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

    func testCommittedOperationFailurePersistsExactFullWireResponseAndReplaysAfterRestart() async throws {
        let fixture = try makeFixture()
        _ = try await admit(fixture.adapter, id: "controller-a", token: "connection-a")
        let before = await fixture.adapter.snapshot()

        let committed = try await fixture.adapter.commitMutation(
            connectionToken: "connection-a",
            requestId: "request-failure",
            operation: "pane.rename"
        ) { state, _ in
            state.surfaceSetRevision += 100
            throw SurfAceLocklessTopologyOperationError.staleTopology(
                currentRevision: 7,
                currentTopology: .object(["type": .string("pane"), "paneId": .integer(1)])
            )
        }

        XCTAssertEqual(committed.outcome, "resolved_failure")
        guard case .object(let response) = committed.terminalResponse else {
            return XCTFail("expected full wire response")
        }
        XCTAssertEqual(response["ok"], .bool(false))
        XCTAssertEqual(response["op"], .string("pane.rename"))
        XCTAssertEqual(response["id"], .string("request-failure"))
        XCTAssertEqual((response["error"]), .object([
            "code": .string("stale_topology"),
            "details": .object([
                "currentRevision": .integer(7),
                "currentTopology": .object(["type": .string("pane"), "paneId": .integer(1)]),
            ]),
            "message": .string("stale_topology"),
        ]))
        let stored = try XCTUnwrap(fixture.store.load())
        XCTAssertEqual(stored.surfaceSetRevision, before.surfaceSetRevision)
        XCTAssertEqual(
            stored.controllers["controller-a"]?.pendingOperationReceipts["request-failure"]?.outcome,
            "resolved_failure"
        )
        XCTAssertEqual(
            stored.controllers["controller-a"]?.pendingOperationReceipts["request-failure"]?.terminalResponse,
            committed.terminalResponse
        )

        let restored = try SurfAceLocklessRuntimeAdapter(
            store: fixture.store,
            legacy: SurfAceLegacyUserDefaultsSnapshot(identityMapping: nil, surfaceTopologies: nil)
        )
        let resumed = try await restored.admit(
            controllerInstanceId: "controller-a",
            controllerProductName: nil,
            connectionToken: "connection-b",
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            protocolFeatures: [surfAceLocklessCapability],
            unresolvedRequestIds: ["request-failure"]
        )
        XCTAssertEqual(resumed.receiptResolutions.first, .object([
            "operationReceipt": .object([
                "commitSequence": .integer(committed.commitSequence),
                "requestId": .string("request-failure"),
            ]),
            "outcome": .string("resolved_failure"),
            "requestId": .string("request-failure"),
            "terminalResponse": committed.terminalResponse,
        ]))
    }

    func testPreDispatchFailureFinalizerPersistsTheExactProvidedWireResponse() async throws {
        let fixture = try makeFixture()
        _ = try await admit(fixture.adapter, id: "controller-a", token: "connection-a")
        let before = await fixture.adapter.snapshot()
        let response: SurfAceLocklessJSON = .object([
            "error": .object([
                "code": .string("invalid_payload"),
                "message": .string("paneId is required"),
            ]),
            "id": .string("request-validation"),
            "ok": .bool(false),
            "op": .string("pane.rename"),
            "sentAt": .integer(1234),
            "type": .string("response"),
            "v": .integer(1),
        ])
        let committed = try await fixture.adapter.commitFailedMutation(
            connectionToken: "connection-a",
            requestId: "request-validation",
            operation: "pane.rename",
            terminalResponse: response
        )
        XCTAssertEqual(committed.outcome, "resolved_failure")
        XCTAssertEqual(committed.terminalResponse, response)
        let after = try XCTUnwrap(fixture.store.load())
        XCTAssertEqual(after.surfaceSetRevision, before.surfaceSetRevision)
        XCTAssertEqual(
            after.controllers["controller-a"]?.pendingOperationReceipts["request-validation"]?.terminalResponse,
            response
        )
        let validationResolutions = try await fixture.adapter.resolveReceipts(
            connectionToken: "connection-a", requestIds: ["request-validation"]
        )
        XCTAssertEqual(validationResolutions.first, .object([
            "operationReceipt": .object([
                "commitSequence": .integer(committed.commitSequence),
                "requestId": .string("request-validation"),
            ]),
            "outcome": .string("resolved_failure"),
            "requestId": .string("request-validation"),
            "terminalResponse": response,
        ]))
    }

    func testReclamationOccurrencePersistsAcrossRestartUntilAcknowledged() async throws {
        let fixture = try makeFixture { state in
            state.limits.maxDormantControllerBytes = 1
        }
        _ = try await admit(fixture.adapter, id: "controller-a", token: "connection-a")
        _ = try await fixture.adapter.commitMutation(
            connectionToken: "connection-a",
            requestId: "request-retained",
            operation: "content.set",
            consumableScopeId: "surface:sf%5F1",
            consumableScopeKind: "surface",
            consumableRecordClass: .content
        ) { _, _ in .object(["status": .string("accepted")]) }
        try await fixture.adapter.disconnect(connectionToken: "connection-a", disconnectedAt: 42)

        let persisted = try XCTUnwrap(fixture.store.load())
        let occurrence = try XCTUnwrap(persisted.pendingControllerRetentionReclamations?.first)
        XCTAssertEqual(occurrence.controllerInstanceId, "controller-a")
        XCTAssertEqual(occurrence.disconnectedAt, 42)
        XCTAssertEqual(occurrence.dormantSequence, 1)
        XCTAssertEqual(occurrence.trigger, "disconnect")
        XCTAssertEqual(occurrence.reason, "byte_capacity")
        XCTAssertEqual(occurrence.eventId, "controller-reclamation:\(occurrence.commitSequence)")
        XCTAssertGreaterThan(occurrence.registryBytes, 0)
        XCTAssertEqual(occurrence.receiptCount, 1)
        XCTAssertGreaterThan(occurrence.receiptBytes, 0)
        XCTAssertEqual(occurrence.cursorCount, 2)
        XCTAssertEqual(occurrence.liveCursorCount, 2)
        XCTAssertEqual(occurrence.surfaceCursorCount, 1)
        XCTAssertEqual(occurrence.tombstoneCursorCount, 0)
        XCTAssertEqual(occurrence.surfaceCount, 1)
        XCTAssertEqual(occurrence.unreadRecordCount, 1)
        XCTAssertEqual(occurrence.unreadRecordCountDiscarded, 1)
        XCTAssertGreaterThan(occurrence.unreadBytesDiscarded, 0)
        XCTAssertEqual(occurrence.maxDormantControllerBytes, 1)

        let restored = try SurfAceLocklessRuntimeAdapter(
            store: fixture.store,
            legacy: SurfAceLegacyUserDefaultsSnapshot(identityMapping: nil, surfaceTopologies: nil)
        )
        let pending = await restored.pendingControllerRetentionReclamations()
        XCTAssertEqual(pending.map(\.record), [occurrence])
        try await restored.acknowledgeControllerRetentionReclamation(
            eventId: occurrence.eventId,
            deliveredControllerInstanceIds: []
        )
        XCTAssertEqual(try fixture.store.load()?.pendingControllerRetentionReclamations, [])
    }

    func testDeferredReclamationPressureDoesNotBlockLaterRetentionOrMutation() async throws {
        let fixture = try makeFixture { state in
            state.limits.maxAdmittedControllerEntries = 2
            state.limits.maxDormantControllerEntries = 1
            state.limits.maxDormantControllerBytes = 1
        }

        for index in 0..<5 {
            let controllerId = "controller-deferred-\(index)"
            let connectionToken = "connection-deferred-\(index)"
            _ = try await admit(fixture.adapter, id: controllerId, token: connectionToken)
            try await fixture.adapter.disconnect(
                connectionToken: connectionToken,
                disconnectedAt: Int64(index + 1)
            )
        }

        let deferred = try XCTUnwrap(
            fixture.store.load()?.pendingControllerRetentionReclamations
        )
        XCTAssertEqual(deferred.count, 5)
        XCTAssertGreaterThan(
            deferred.count,
            Int(try XCTUnwrap(fixture.store.load()).limits.maxAdmittedControllerEntries)
        )
        XCTAssertEqual(deferred.map(\.commitSequence), deferred.map(\.commitSequence).sorted())
        XCTAssertEqual(Set(deferred.map(\.eventId)).count, deferred.count)

        _ = try await admit(
            fixture.adapter,
            id: "controller-mutation",
            token: "connection-mutation"
        )
        let committed = try await fixture.adapter.commitMutation(
            connectionToken: "connection-mutation",
            requestId: "request-after-deferred-pressure",
            operation: "surface.window.open"
        ) { state, sequence in
            state.surfaceSetRevision += 1
            return .object([
                "commitSequence": .integer(sequence),
                "surfaceSetRevision": .integer(state.surfaceSetRevision),
            ])
        }
        XCTAssertEqual(committed.outcome, "resolved_success")
        XCTAssertEqual(
            try fixture.store.load()?.pendingControllerRetentionReclamations,
            deferred
        )
        try await fixture.adapter.disconnect(
            connectionToken: "connection-mutation",
            disconnectedAt: 6
        )
        let pendingAfterLaterRetention = try XCTUnwrap(
            fixture.store.load()?.pendingControllerRetentionReclamations
        )
        XCTAssertEqual(pendingAfterLaterRetention.count, 6)

        let restored = try SurfAceLocklessRuntimeAdapter(
            store: fixture.store,
            legacy: SurfAceLegacyUserDefaultsSnapshot(identityMapping: nil, surfaceTopologies: nil)
        )
        let restoredPending = await restored.pendingControllerRetentionReclamations().map(\.record)
        XCTAssertEqual(restoredPending, pendingAfterLaterRetention)
    }

    func testReclamationDeliveryRetainsCommitTimeRecipientAcrossDisconnectAndResume() async throws {
        let fixture = try makeFixture { state in
            state.limits.maxAdmittedControllerEntries = 2
        }
        _ = try await admit(fixture.adapter, id: "controller-recipient", token: "connection-recipient")
        _ = try await admit(fixture.adapter, id: "controller-victim", token: "connection-victim")
        try await fixture.adapter.disconnect(connectionToken: "connection-victim", disconnectedAt: 1)

        _ = try await admit(fixture.adapter, id: "controller-new", token: "connection-new")
        let committed = try XCTUnwrap(fixture.store.load()?.pendingControllerRetentionReclamations?.first)
        XCTAssertEqual(
            committed.recipientControllerInstanceIds,
            ["controller-new", "controller-recipient"]
        )

        try await fixture.adapter.disconnect(connectionToken: "connection-recipient", disconnectedAt: 2)
        let whileDisconnected = await fixture.adapter.pendingControllerRetentionReclamations()
        XCTAssertNil(
            whileDisconnected.first?.connectionTokensByControllerInstanceId["controller-recipient"]
        )
        try await fixture.adapter.acknowledgeControllerRetentionReclamation(
            eventId: committed.eventId,
            deliveredControllerInstanceIds: ["controller-new"]
        )
        XCTAssertNotNil(try fixture.store.load()?.pendingControllerRetentionReclamations?.first)

        _ = try await admit(
            fixture.adapter,
            id: "controller-recipient",
            token: "connection-recipient-resumed"
        )
        let resumed = await fixture.adapter.pendingControllerRetentionReclamations()
        XCTAssertEqual(
            resumed.first?.connectionTokensByControllerInstanceId,
            ["controller-recipient": "connection-recipient-resumed"]
        )
        try await fixture.adapter.acknowledgeControllerRetentionReclamation(
            eventId: committed.eventId,
            deliveredControllerInstanceIds: ["controller-recipient"]
        )
        XCTAssertEqual(try fixture.store.load()?.pendingControllerRetentionReclamations, [])
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
        let capacityResolutions = try await fixture.adapter.resolveReceipts(
            connectionToken: "connection-a", requestIds: ["request-capacity"]
        )
        XCTAssertEqual(capacityResolutions, [.object([
            "outcome": .string("not_committed"),
            "requestId": .string("request-capacity"),
        ])])
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
        let targetCapacityResolutions = try await fixture.adapter.resolveReceipts(
            connectionToken: "connection-a", requestIds: ["operation-capacity"]
        )
        XCTAssertEqual(targetCapacityResolutions, [.object([
            "outcome": .string("not_committed"),
            "requestId": .string("operation-capacity"),
        ])])
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
        let encodedOriginalId = originalId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? originalId
        let originalSurfaceScope = "surface:\(encodedOriginalId)"
        if var scope = state.scopes.removeValue(forKey: originalSurfaceScope) {
            scope.scopeId = "surface:sf%5F1"
            state.scopes[scope.scopeId] = scope
        }
        let originalPaneScope = "pane:\(encodedOriginalId):1"
        if var scope = state.scopes.removeValue(forKey: originalPaneScope) {
            scope.scopeId = "pane:sf%5F1:1"
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
