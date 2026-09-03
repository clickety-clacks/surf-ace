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

    func testCanonicalTopologyCodecRejectsNoncanonicalShapeAndRoundTripsCanonicalTree() throws {
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

    func testCompleteNativeTargetAdvertisesAndRejectsRequestsWithoutTheCurrentCapability() {
        XCTAssertTrue(SurfAceLocklessTargetAdmission.platformPermitsLockless)
        XCTAssertTrue(SurfAceLocklessTargetAdmission.implementationComplete)
        XCTAssertEqual(SurfAceLocklessTargetAdmission.unroutedNetworkOperations, [])
        XCTAssertEqual(SurfAceLocklessTargetAdmission.advertisedProtocolFeatures, [surfAceLocklessCapability])
        XCTAssertTrue(SurfAceLocklessTargetAdmission.isLocklessRequest([
            "protocolFeatures": [surfAceLocklessCapability],
        ]))
        XCTAssertFalse(SurfAceLocklessTargetAdmission.isLocklessRequest([
            "protocolFeatures": [],
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
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)

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
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)

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

        _ = try SurfAceLocklessRuntimeAdapter(store: store)
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

        let restored = try SurfAceLocklessRuntimeAdapter(store: fixture.store)
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

        let restored = try SurfAceLocklessRuntimeAdapter(store: fixture.store)
        let pending = await restored.pendingControllerRetentionReclamations()
        XCTAssertEqual(pending.map(\.record), [occurrence])
        try await restored.acknowledgeControllerRetentionReclamation(
            eventId: occurrence.eventId,
            deliveredControllerInstanceIds: []
        )
        XCTAssertEqual(try fixture.store.load()?.pendingControllerRetentionReclamations, [])
    }

    func testACCLOSE09TombstoneReclamationOutboxPersistsOrderedCommitRecipientsUntilDelivery() async throws {
        let fixture = try makeFixture { state in
            state.limits.maxRetainedTombstones = 1
        }
        _ = try await admit(fixture.adapter, id: "controller-a", token: "connection-a")
        _ = try await admit(fixture.adapter, id: "controller-b", token: "connection-b")

        _ = try await fixture.adapter.commitMutation(
            connectionToken: "connection-a", requestId: "close-first", operation: "surface.window.close"
        ) { state, _ in
            let result = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
                state: &state, surfaceId: "sf_1",
                expectedSurfaceSetRevision: 1, expectedTopologyRevision: 0
            )
            return .string(result.tombstoneId)
        }
        let opened = try await fixture.adapter.commitMutation(
            connectionToken: "connection-a", requestId: "open-second", operation: "surface.window.open"
        ) { state, _ in
            let result = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
                state: &state, expectedSurfaceSetRevision: 2
            )
            return .string(result.surface.surfaceId)
        }
        guard case .string(let secondSurfaceId) = opened.responsePayload else {
            return XCTFail("missing second surface identity")
        }
        _ = try await fixture.adapter.commitMutation(
            connectionToken: "connection-b", requestId: "close-second", operation: "surface.window.close"
        ) { state, _ in
            let result = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
                state: &state, surfaceId: secondSurfaceId,
                expectedSurfaceSetRevision: 3, expectedTopologyRevision: 0
            )
            return .string(result.tombstoneId)
        }

        let persisted = try XCTUnwrap(fixture.store.load())
        let occurrence = try XCTUnwrap(persisted.pendingTombstoneReclamations?.first)
        XCTAssertEqual(occurrence.commitSequence, 3)
        XCTAssertEqual(occurrence.surfaceId, "sf_1")
        XCTAssertEqual(occurrence.recipientControllerInstanceIds, ["controller-a", "controller-b"])
        XCTAssertEqual(occurrence.deliveredControllerInstanceIds, [])
        XCTAssertEqual(occurrence.reason, .countCapacity)
        XCTAssertEqual(occurrence.maxRetainedTombstones, 1)
        XCTAssertGreaterThan(occurrence.maxRetainedTombstoneBytes, occurrence.bytes)

        let pendingDeliveries = await fixture.adapter.pendingTombstoneReclamations()
        let delivery = try XCTUnwrap(pendingDeliveries.first)
        XCTAssertEqual(delivery.record, occurrence)
        XCTAssertEqual(delivery.connectionTokensByControllerInstanceId, [
            "controller-a": "connection-a", "controller-b": "connection-b",
        ])
        try await fixture.adapter.acknowledgeTombstoneReclamation(
            eventId: occurrence.eventId, deliveredControllerInstanceIds: ["controller-a"]
        )
        XCTAssertEqual(
            try fixture.store.load()?.pendingTombstoneReclamations?.first?.deliveredControllerInstanceIds,
            ["controller-a"]
        )
        try await fixture.adapter.acknowledgeTombstoneReclamation(
            eventId: occurrence.eventId, deliveredControllerInstanceIds: ["controller-b"]
        )
        XCTAssertEqual(try fixture.store.load()?.pendingTombstoneReclamations, [])
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

        let restored = try SurfAceLocklessRuntimeAdapter(store: fixture.store)
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
        let request = Self.validTargetRequest(paneId: 1)
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
        XCTAssertNil(after.targetApplyWorkItems[
            targetIdentity(controllerId: "controller-a", operationRequestId: "operation-capacity").storageKey
        ])
        XCTAssertNil(after.controllers["controller-a"]?.pendingOperationReceipts["operation-capacity"])
        let targetCapacityResolutions = try await fixture.adapter.resolveReceipts(
            connectionToken: "connection-a", requestIds: ["operation-capacity"]
        )
        XCTAssertEqual(targetCapacityResolutions, [.object([
            "outcome": .string("not_committed"),
            "requestId": .string("operation-capacity"),
        ])])
    }

    func testTargetAdmissionRevalidatesLiveSurfaceAfterFormerPreflightPause() async throws {
        let gate = SurfAceTargetAdmissionTestGate(operationRequestId: "operation-surface-close")
        let fixture = try makeFixture(
            targetIntentAdmissionPreparation: { await gate.prepare($0) }
        )
        let adapter = fixture.adapter
        _ = try await admit(adapter, id: "controller-a", token: "connection-a")
        let before = await adapter.snapshot()
        let request = Self.validTargetRequest(paneId: 1)
        let intent = Task.detached {
            try await adapter.commitTargetIntent(
                connectionToken: "connection-a",
                operationRequestId: "operation-surface-close",
                targetRequestId: "target-request-surface-close",
                surfaceId: "sf_1",
                targetId: "target-surface-close",
                targetEpoch: 1,
                request: request
            )
        }

        await gate.waitUntilHeld()
        _ = try await adapter.commitLocalMutation(operation: "local.surface.close") { state, _ in
            _ = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
                state: &state,
                surfaceId: "sf_1",
                expectedSurfaceSetRevision: state.surfaceSetRevision,
                expectedTopologyRevision: state.liveSurfaces["sf_1"]?.topologyRevision ?? -1
            )
            return .object(["surfaceId": .string("sf_1")])
        }
        await gate.release()
        await XCTAssertThrowsErrorAsync { _ = try await intent.value } verify: { error in
            XCTAssertEqual(
                error as? SurfAceLocklessRuntimeAdapterError,
                .targetPrecommit(
                    code: "invalid_payload",
                    targetErrorCode: "pane_lineage_missing",
                    message: "target.apply surface is not live"
                )
            )
        }
        try await assertUnreceiptedTargetRejection(
            adapter,
            before: before,
            operationRequestId: "operation-surface-close"
        )
        let after = await adapter.snapshot()
        XCTAssertNil(after.liveSurfaces["sf_1"])
        XCTAssertTrue(after.surfaceTombstones.contains { $0.surface.surfaceId == "sf_1" })
    }

    func testTargetAdmissionRevalidatesPaneLineageAfterFormerPreflightPause() async throws {
        let gate = SurfAceTargetAdmissionTestGate(operationRequestId: "operation-pane-close")
        let fixture = try makeFixture(
            configure: { state in
                _ = try SurfAceLocklessTopologyOperations.paneSplit(
                    state: &state,
                    surfaceId: "sf_1",
                    paneId: 1,
                    count: 2,
                    direction: "horizontal",
                    expectedTopologyRevision: 0
                )
            },
            targetIntentAdmissionPreparation: { await gate.prepare($0) }
        )
        let adapter = fixture.adapter
        _ = try await admit(adapter, id: "controller-a", token: "connection-a")
        let before = await adapter.snapshot()
        let pane = try XCTUnwrap(before.liveSurfaces["sf_1"]?.panes["2"])
        let request = Self.validTargetRequest(paneLineageId: pane.paneLineageId)
        let intent = Task.detached {
            try await adapter.commitTargetIntent(
                connectionToken: "connection-a",
                operationRequestId: "operation-pane-close",
                targetRequestId: "target-request-pane-close",
                surfaceId: "sf_1",
                targetId: "target-pane-close",
                targetEpoch: 1,
                request: request
            )
        }

        await gate.waitUntilHeld()
        _ = try await adapter.commitLocalMutation(operation: "local.pane.close") { state, _ in
            _ = try SurfAceLocklessTopologyOperations.paneClose(
                state: &state,
                surfaceId: "sf_1",
                paneId: pane.paneId,
                expectedTopologyRevision: state.liveSurfaces["sf_1"]?.topologyRevision ?? -1
            )
            return .object(["paneId": .integer(pane.paneId), "surfaceId": .string("sf_1")])
        }
        await gate.release()
        await XCTAssertThrowsErrorAsync { _ = try await intent.value } verify: { error in
            guard case .targetPrecommit(_, let targetErrorCode, _) =
                    error as? SurfAceLocklessRuntimeAdapterError else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(targetErrorCode, "pane_lineage_missing")
        }
        try await assertUnreceiptedTargetRejection(
            adapter,
            before: before,
            operationRequestId: "operation-pane-close"
        )
    }

    func testTargetAdmissionRevalidatesAnnotationPolicyAfterFormerPreflightPause() async throws {
        let gate = SurfAceTargetAdmissionTestGate(operationRequestId: "operation-policy")
        let fixture = try makeFixture(
            targetIntentAdmissionPreparation: { await gate.prepare($0) }
        )
        let adapter = fixture.adapter
        _ = try await admit(adapter, id: "controller-a", token: "connection-a")
        let before = await adapter.snapshot()
        let request = Self.validTargetRequest(paneId: 1)
        let intent = Task.detached {
            try await adapter.commitTargetIntent(
                connectionToken: "connection-a",
                operationRequestId: "operation-policy",
                targetRequestId: "target-request-policy",
                surfaceId: "sf_1",
                targetId: "target-policy",
                targetEpoch: 1,
                request: request
            )
        }

        await gate.waitUntilHeld()
        _ = try await adapter.commitLocalMutation(operation: "local.annotation.mode") { state, _ in
            state.liveSurfaces["sf_1"]?.panes["1"]?.annotationMode = true
            return .object(["paneId": .integer(1), "surfaceId": .string("sf_1")])
        }
        await gate.release()
        await XCTAssertThrowsErrorAsync { _ = try await intent.value } verify: { error in
            guard case .targetPrecommit(_, let targetErrorCode, _) =
                    error as? SurfAceLocklessRuntimeAdapterError else {
                return XCTFail("unexpected error: \(error)")
            }
            XCTAssertEqual(targetErrorCode, "policy_denied")
        }
        try await assertUnreceiptedTargetRejection(
            adapter,
            before: before,
            operationRequestId: "operation-policy"
        )
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
        let committed = try await adapter.commitTargetIntent(
            connectionToken: "connection-a",
            operationRequestId: "operation-1",
            targetRequestId: "target-request-1",
            surfaceId: "sf_1",
            targetId: "target-1",
            targetEpoch: 2,
            request: Self.validTargetRequest(paneId: 1)
        )
        let identity = try XCTUnwrap(committed.targetOperationIdentity)
        XCTAssertEqual(
            try fixture.store.load()?.targetApplyWorkItems[identity.storageKey]?.state,
            .intentCommitted
        )

        let result = try await adapter.materializeTargetWork(identity: identity) { _ in
            XCTAssertEqual(
                try? fixture.store.load()?.targetApplyWorkItems[identity.storageKey]?.state,
                .materializing
            )
            return SurfAceLocklessMaterializationOutcome(
                errorCode: nil,
                materializedState: .object(["url": .string("https://example.com")]),
                status: "applied"
            )
        }
        XCTAssertEqual(result.status, "applied")
        XCTAssertNil(try fixture.store.load()?.targetApplyWorkItems[identity.storageKey])
        XCTAssertEqual(try fixture.store.load()?.targetApplyResults[identity.storageKey], result)
    }

    func testTargetWorkAndResultsAreScopedByControllerForSameOperationRequestId() async throws {
        let fixture = try makeFixture()
        let adapter = fixture.adapter
        _ = try await admit(adapter, id: "controller-a", token: "connection-a")
        _ = try await admit(adapter, id: "controller-b", token: "connection-b")
        let operationRequestId = "shared-operation"

        let committedA = try await adapter.commitTargetIntent(
            connectionToken: "connection-a",
            operationRequestId: operationRequestId,
            targetRequestId: "target-request-a",
            surfaceId: "sf_1",
            targetId: "target-a",
            targetEpoch: 1,
            request: Self.validTargetRequest(paneId: 1, url: "https://a.example")
        )
        let committedB = try await adapter.commitTargetIntent(
            connectionToken: "connection-b",
            operationRequestId: operationRequestId,
            targetRequestId: "target-request-b",
            surfaceId: "sf_1",
            targetId: "target-b",
            targetEpoch: 2,
            request: Self.validTargetRequest(paneId: 1, url: "https://b.example")
        )
        let identityA = try XCTUnwrap(committedA.targetOperationIdentity)
        let identityB = try XCTUnwrap(committedB.targetOperationIdentity)
        XCTAssertNotEqual(identityA.storageKey, identityB.storageKey)
        XCTAssertNotEqual(committedA.commitSequence, committedB.commitSequence)

        let committedState = try XCTUnwrap(fixture.store.load())
        XCTAssertEqual(committedState.targetApplyWorkItems.count, 2)
        XCTAssertEqual(
            committedState.targetApplyWorkItems[identityA.storageKey]?.controllerInstanceId,
            "controller-a"
        )
        XCTAssertEqual(
            committedState.targetApplyWorkItems[identityB.storageKey]?.controllerInstanceId,
            "controller-b"
        )
        XCTAssertEqual(
            committedState.controllers["controller-a"]?
                .pendingOperationReceipts[operationRequestId]?.commitSequence,
            committedA.commitSequence
        )
        XCTAssertEqual(
            committedState.controllers["controller-b"]?
                .pendingOperationReceipts[operationRequestId]?.commitSequence,
            committedB.commitSequence
        )

        let resultA = try await adapter.materializeTargetWork(identity: identityA) { work in
            XCTAssertEqual(work.controllerInstanceId, "controller-a")
            XCTAssertEqual(work.targetRequestId, "target-request-a")
            return SurfAceLocklessMaterializationOutcome(
                errorCode: nil,
                materializedState: .object(["url": .string("https://a.example")]),
                status: "applied"
            )
        }
        let afterA = try XCTUnwrap(fixture.store.load())
        XCTAssertNil(afterA.targetApplyWorkItems[identityA.storageKey])
        XCTAssertNotNil(afterA.targetApplyWorkItems[identityB.storageKey])
        XCTAssertEqual(afterA.targetApplyResults[identityA.storageKey], resultA)
        XCTAssertNil(afterA.targetApplyResults[identityB.storageKey])

        let resultB = try await adapter.materializeTargetWork(identity: identityB) { work in
            XCTAssertEqual(work.controllerInstanceId, "controller-b")
            XCTAssertEqual(work.targetRequestId, "target-request-b")
            return SurfAceLocklessMaterializationOutcome(
                errorCode: nil,
                materializedState: .object(["url": .string("https://b.example")]),
                status: "applied"
            )
        }
        XCTAssertEqual(resultA.controllerInstanceId, "controller-a")
        XCTAssertEqual(resultB.controllerInstanceId, "controller-b")
        XCTAssertEqual(resultA.operationRequestId, operationRequestId)
        XCTAssertEqual(resultB.operationRequestId, operationRequestId)
        XCTAssertEqual(resultA.targetRequestId, "target-request-a")
        XCTAssertEqual(resultB.targetRequestId, "target-request-b")
        let storedResultA = await adapter.targetResult(identity: identityA)
        let storedResultB = await adapter.targetResult(identity: identityB)
        XCTAssertEqual(storedResultA, resultA)
        XCTAssertEqual(storedResultB, resultB)
        let terminalState = try XCTUnwrap(fixture.store.load())
        XCTAssertTrue(terminalState.targetApplyWorkItems.isEmpty)
        XCTAssertEqual(terminalState.targetApplyResults.count, 2)
    }

    private func makeFixture(
        configure: (inout SurfAceLocklessAuthorityState) throws -> Void = { _ in },
        targetIntentAdmissionPreparation: (@Sendable (String) async -> Void)? = nil
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
        return (
            try SurfAceLocklessRuntimeAdapter(
                store: store,
                targetIntentAdmissionPreparation: targetIntentAdmissionPreparation
            ),
            store
        )
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

    private static func validTargetRequest(
        paneId: Int64? = nil,
        paneLineageId: String? = nil,
        url: String = "https://example.com"
    ) -> SurfAceLocklessJSON {
        var request: [String: SurfAceLocklessJSON] = [
            "requestId": .string("target-request"),
            "restoreReason": .string("initial"),
            "surfaceId": .string("sf_1"),
            "targetEpoch": .integer(1),
            "targetHeader": .object([
                "replaySemantics": .string("navigate"),
                "requiredCapabilities": .array([.string("target.browser_url.v1")]),
            ]),
            "targetId": .string("target"),
            "targetKind": .string("browser_url"),
            "targetPayload": .object(["url": .string(url)]),
        ]
        request["paneId"] = paneId.map(SurfAceLocklessJSON.integer)
        request["paneLineageId"] = paneLineageId.map(SurfAceLocklessJSON.string)
        return .object(request)
    }

    private func targetIdentity(
        controllerId: String,
        operationRequestId: String
    ) -> SurfAceLocklessTargetOperationIdentity {
        SurfAceLocklessTargetOperationIdentity(
            controllerInstanceId: controllerId,
            operationRequestId: operationRequestId
        )
    }

    private func assertUnreceiptedTargetRejection(
        _ adapter: SurfAceLocklessRuntimeAdapter,
        before: SurfAceLocklessAuthorityState,
        operationRequestId: String
    ) async throws {
        let after = await adapter.snapshot()
        let beforeReceipts = try XCTUnwrap(
            before.controllers["controller-a"]?.pendingOperationReceipts
        )
        let afterReceipts = try XCTUnwrap(
            after.controllers["controller-a"]?.pendingOperationReceipts
        )
        XCTAssertEqual(afterReceipts.count, beforeReceipts.count)
        XCTAssertEqual(
            afterReceipts.values.reduce(Int64(0)) { $0 + $1.bytes },
            beforeReceipts.values.reduce(Int64(0)) { $0 + $1.bytes }
        )
        XCTAssertNil(afterReceipts[operationRequestId])
        XCTAssertEqual(after.targetApplyWorkItems, before.targetApplyWorkItems)
        XCTAssertEqual(after.targetApplyResults, before.targetApplyResults)
        let resolutions = try await adapter.resolveReceipts(
            connectionToken: "connection-a",
            requestIds: [operationRequestId]
        )
        XCTAssertEqual(resolutions, [.object([
            "outcome": .string("not_committed"),
            "requestId": .string(operationRequestId),
        ])])
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

extension SurfAceLocklessRuntimeAdapterTests {
    func testACRET01DormantOrderIgnoresReadsAndLabelsThenResumeKeepsCursors() async throws {
        let fixture = try makeFixture()
        _ = try await fixture.adapter.admit(
            controllerInstanceId: "a", controllerProductName: "before", connectionToken: "ta",
            projectionCapacityBytes: 8_388_608, protocolFeatures: [surfAceLocklessCapability], surfaceId: "sf_1"
        )
        try await fixture.adapter.disconnect(connectionToken: "ta", disconnectedAt: 10)
        let dormant = await fixture.adapter.snapshot()
        let sequence = dormant.controllers["a"]?.dormantSequence
        let cursors = dormant.scopes.mapValues(\.cursors)
        _ = await fixture.adapter.readinessSnapshot()
        let afterRead = await fixture.adapter.snapshot()
        XCTAssertEqual(afterRead.controllers["a"]?.dormantSequence, sequence)
        let resumed = try await fixture.adapter.admit(
            controllerInstanceId: "a", controllerProductName: "after", connectionToken: "ta2",
            projectionCapacityBytes: 8_388_608, protocolFeatures: [surfAceLocklessCapability], surfaceId: "sf_1"
        )
        XCTAssertTrue(resumed.resumed)
        XCTAssertEqual(resumed.state.scopes.mapValues(\.cursors), cursors)
        try await fixture.adapter.disconnect(connectionToken: "ta2", disconnectedAt: 20)
        let secondSequence = (await fixture.adapter.snapshot()).controllers["a"]?.dormantSequence
        XCTAssertGreaterThan(try XCTUnwrap(secondSequence), try XCTUnwrap(sequence))
        let fresh = try await fixture.adapter.admit(
            controllerInstanceId: "fresh", controllerProductName: "after", connectionToken: "fresh",
            projectionCapacityBytes: 8_388_608, protocolFeatures: [surfAceLocklessCapability], surfaceId: "sf_1"
        )
        XCTAssertTrue(fresh.state.scopes.values.allSatisfy {
            $0.cursors["fresh"]?.cursor == $0.nextSequence
        })
    }

    func testACRET02CountByteAndRestartPressureAlwaysReclaimsOldestSequence() async throws {
        try await testDormantCountPressureReclaimsOldestAndReadmissionStartsAtCurrentTail()
        try await testDisconnectOverDormantByteBoundReclaimsWithoutRejectingTransition()
        try testRestartDormancyBytePressureReclaimsBySequenceNotIdentity()
    }

    func testACRET04LiveOnlyCapacityRefusesThenDormantAdmissionReclaimsAcrossRestart() async throws {
        let fixture = try makeFixture { $0.limits.maxAdmittedControllerEntries = 2 }
        _ = try await admit(fixture.adapter, id: "z", token: "tz")
        _ = try await admit(fixture.adapter, id: "a", token: "ta")
        let before = await fixture.adapter.snapshot()
        await XCTAssertThrowsErrorAsync {
            _ = try await self.admit(fixture.adapter, id: "new", token: "tn")
        } verify: { XCTAssertEqual($0 as? SurfAceLocklessRuntimeAdapterError, .controllerCapacity) }
        let afterRefusal = await fixture.adapter.snapshot()
        XCTAssertEqual(afterRefusal, before)
        try await fixture.adapter.disconnect(connectionToken: "tz", disconnectedAt: 1)
        let restarted = try SurfAceLocklessRuntimeAdapter(store: fixture.store)
        _ = try await admit(restarted, id: "new", token: "tn")
        let state = await restarted.snapshot()
        XCTAssertNil(state.controllers["z"])
        XCTAssertEqual(state.controllers.keys.sorted(), ["a", "new"])
    }

    func testACOPS02MutationsOverflowAndReclamationHaveStableCommitCorrelation() async throws {
        try await testMutationPersistsExactReceiptBeforeFanoutAndAckRemovesIt()
        try await testReclamationOccurrencePersistsAcrossRestartUntilAcknowledged()
        testRuntimeMapsCapacityErrorsToCanonicalCodesAndDetails()
    }

    func testACID02DuplicateLiveIdentityPreservesIncumbentCursorUntilReaping() async throws {
        let fixture = try makeFixture()
        _ = try await admit(fixture.adapter, id: "controller-a", token: "incumbent")
        let before = await fixture.adapter.snapshot()
        await XCTAssertThrowsErrorAsync {
            _ = try await self.admit(fixture.adapter, id: "controller-a", token: "newcomer")
        } verify: { XCTAssertEqual($0 as? SurfAceLocklessRuntimeAdapterError, .duplicateLiveController) }
        let afterCollision = await fixture.adapter.snapshot()
        XCTAssertEqual(afterCollision.scopes, before.scopes)
        await XCTAssertThrowsErrorAsync {
            _ = try await self.admit(fixture.adapter, id: "controller-a", token: "newcomer")
        } verify: { XCTAssertEqual($0 as? SurfAceLocklessRuntimeAdapterError, .duplicateLiveController) }
        try await fixture.adapter.disconnect(connectionToken: "incumbent", disconnectedAt: 1)
        let resumed = try await admit(fixture.adapter, id: "controller-a", token: "newcomer")
        XCTAssertTrue(resumed.resumed)
    }

    func testACID03DuplicateHumanLabelsDoNotDedupeControllersOrCursors() async throws {
        let fixture = try makeFixture()
        let a = try await fixture.adapter.admit(
            controllerInstanceId: "a", controllerProductName: "Same", connectionToken: "ta",
            projectionCapacityBytes: 8_388_608, protocolFeatures: [surfAceLocklessCapability], surfaceId: "sf_1"
        )
        let b = try await fixture.adapter.admit(
            controllerInstanceId: "b", controllerProductName: "Same", connectionToken: "tb",
            projectionCapacityBytes: 8_388_608, protocolFeatures: [surfAceLocklessCapability], surfaceId: "sf_1"
        )
        XCTAssertEqual(a.state.controllers["a"]?.controllerProductName, "Same")
        XCTAssertEqual(b.state.controllers.keys.sorted(), ["a", "b"])
        XCTAssertEqual(Set(b.state.scopes.values.flatMap { $0.cursors.keys }), ["a", "b"])
        let ca = try await fixture.adapter.commitMutation(
            connectionToken: "ta", requestId: "a1", operation: "content.set"
        ) { _, sequence in .integer(sequence) }
        let cb = try await fixture.adapter.commitMutation(
            connectionToken: "tb", requestId: "b1", operation: "content.set"
        ) { _, sequence in .integer(sequence) }
        XCTAssertLessThan(ca.commitSequence, cb.commitSequence)
    }

    func testACARCH01SurvivorRemainsActionableAcrossPeerPartitionAndRestart() async throws {
        let fixture = try makeFixture()
        _ = try await admit(fixture.adapter, id: "a", token: "ta")
        _ = try await admit(fixture.adapter, id: "b", token: "tb")
        try await fixture.adapter.disconnect(connectionToken: "ta", disconnectedAt: 1)
        let commit = try await fixture.adapter.commitMutation(
            connectionToken: "tb", requestId: "topology-1", operation: "pane.rename"
        ) { state, sequence in
            _ = try SurfAceLocklessTopologyOperations.paneRename(
                state: &state, surfaceId: "sf_1", paneId: 1,
                name: "survivor", expectedTopologyRevision: 0
            )
            return .integer(sequence)
        }
        XCTAssertEqual(commit.commitSequence, 1)
        let restarted = try SurfAceLocklessRuntimeAdapter(store: fixture.store)
        let resumed = try await admit(restarted, id: "b", token: "tb2")
        let restartedState = await restarted.snapshot()
        XCTAssertTrue(resumed.resumed)
        XCTAssertEqual(restartedState.liveSurfaces["sf_1"]?.panes["1"]?.name, "survivor")
    }

    func testACSYNC01DisconnectedContentAndTopologyWritesNeverEnterAuthority() async throws {
        let fixture = try makeFixture()
        _ = try await admit(fixture.adapter, id: "a", token: "ta")
        try await fixture.adapter.disconnect(connectionToken: "ta", disconnectedAt: 1)
        let before = await fixture.adapter.snapshot()
        for operation in ["content.set", "pane.rename"] {
            await XCTAssertThrowsErrorAsync {
                _ = try await fixture.adapter.commitMutation(
                    connectionToken: "ta", requestId: operation, operation: operation
                ) { _, _ in XCTFail("disconnected mutation executed"); return .null }
            } verify: { XCTAssertEqual($0 as? SurfAceLocklessRuntimeAdapterError, .notPaired) }
        }
        let afterDisconnectedWrites = await fixture.adapter.snapshot()
        XCTAssertEqual(afterDisconnectedWrites, before)
        let resumed = try await admit(fixture.adapter, id: "a", token: "ta2")
        let afterResume = await fixture.adapter.snapshot()
        XCTAssertTrue(resumed.resumed)
        XCTAssertNil(afterResume.controllers["a"]?.pendingOperationReceipts["content.set"])
    }

    func testACSYNC02OnePersistedAuthorityReplicaOwnsRemoteAndLocalWrites() async throws {
        let fixture = try makeFixture()
        _ = try await admit(fixture.adapter, id: "a", token: "ta")
        _ = try await fixture.adapter.commitMutation(
            connectionToken: "ta", requestId: "remote", operation: "content.set"
        ) { state, sequence in state.surfaceSetRevision += 1; return .integer(sequence) }
        _ = try await fixture.adapter.commitLocalMutation(operation: "local.resize") {
            state, sequence in state.surfaceSetRevision += 1; return .integer(sequence)
        }
        let snapshot = await fixture.adapter.snapshot()
        XCTAssertEqual(snapshot, try fixture.store.load())
        XCTAssertEqual(snapshot.generation, 3)
        XCTAssertEqual(snapshot.surfaceSetRevision, 3)
    }

    func testACSYNC03OfflineAndIncompleteCapabilityTripwiresRejectBeforeMutation() async throws {
        let fixture = try makeFixture()
        let before = await fixture.adapter.snapshot()
        await XCTAssertThrowsErrorAsync {
            _ = try await fixture.adapter.admit(
                controllerInstanceId: "offline", controllerProductName: nil,
                connectionToken: "offline", projectionCapacityBytes: 8_388_608,
                protocolFeatures: []
            )
        } verify: { XCTAssertEqual($0 as? SurfAceLocklessRuntimeAdapterError, .invalidAdmission) }
        let after = await fixture.adapter.snapshot()
        XCTAssertEqual(after, before)
        XCTAssertTrue(SurfAceLocklessTargetAdmission.implementationComplete)
        XCTAssertTrue(SurfAceLocklessTargetAdmission.unroutedNetworkOperations.isEmpty)
    }

    func testACTOPO06ReceiptReplayChangedPayloadReuseAndFreshIDRecompute() async throws {
        let fixture = try makeFixture()
        _ = try await admit(fixture.adapter, id: "a", token: "ta")
        let original = try await fixture.adapter.commitMutation(
            connectionToken: "ta", requestId: "same", operation: "pane.rename"
        ) { state, sequence in
            _ = try SurfAceLocklessTopologyOperations.paneRename(
                state: &state, surfaceId: "sf_1", paneId: 1, name: "one", expectedTopologyRevision: 0
            )
            return .integer(sequence)
        }
        await XCTAssertThrowsErrorAsync {
            _ = try await fixture.adapter.commitMutation(
                connectionToken: "ta", requestId: "same", operation: "pane.rename"
            ) { _, _ in XCTFail("reused ID mutated"); return .null }
        } verify: { XCTAssertEqual($0 as? SurfAceLocklessRuntimeAdapterError, .invalidAdmission) }
        let replay = try await fixture.adapter.resolveReceipts(
            connectionToken: "ta", requestIds: ["same"]
        )
        guard case .object(let resolution) = replay.first else {
            return XCTFail("missing receipt resolution")
        }
        XCTAssertEqual(resolution["terminalResponse"], original.terminalResponse)
        XCTAssertEqual(resolution["outcome"], .string("resolved_success"))
        let fresh = try await fixture.adapter.commitMutation(
            connectionToken: "ta", requestId: "fresh", operation: "pane.rename"
        ) { state, sequence in
            _ = try SurfAceLocklessTopologyOperations.paneRename(
                state: &state, surfaceId: "sf_1", paneId: 1, name: "two", expectedTopologyRevision: 1
            )
            return .integer(sequence)
        }
        XCTAssertGreaterThan(fresh.commitSequence, original.commitSequence)
    }

}

private actor SurfAceTargetAdmissionTestGate {
    private let operationRequestId: String
    private var isHeld = false
    private var heldWaiters: [CheckedContinuation<Void, Never>] = []
    private var releaseWaiters: [CheckedContinuation<Void, Never>] = []
    private var isReleased = false

    init(operationRequestId: String) {
        self.operationRequestId = operationRequestId
    }

    func prepare(_ candidateRequestId: String) async {
        guard candidateRequestId == operationRequestId else { return }
        isHeld = true
        let waiters = heldWaiters
        heldWaiters.removeAll()
        waiters.forEach { $0.resume() }
        guard !isReleased else { return }
        await withCheckedContinuation { continuation in
            releaseWaiters.append(continuation)
        }
    }

    func waitUntilHeld() async {
        guard !isHeld else { return }
        await withCheckedContinuation { continuation in
            heldWaiters.append(continuation)
        }
    }

    func release() {
        isReleased = true
        let waiters = releaseWaiters
        releaseWaiters.removeAll()
        waiters.forEach { $0.resume() }
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
