import Foundation
import XCTest
@testable import SurfAce

final class SurfAceLocklessRuntimeAdapterTests: XCTestCase {
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
        XCTAssertEqual(try fixture.store.load()?.surfaceSetRevision, 1)
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
        XCTAssertEqual(stored.surfaceSetRevision, 1)
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
            surfaceId: "surface-1",
            targetId: "target-1",
            targetEpoch: 2,
            request: .object(["url": .string("https://example.com")])
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

    private func makeFixture() throws -> (
        adapter: SurfAceLocklessRuntimeAdapter,
        store: SurfAceLocklessGenerationStore
    ) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceLocklessRuntimeAdapterTests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        let legacy = SurfAceLegacyUserDefaultsSnapshot(identityMapping: nil, surfaceTopologies: nil)
        return (try SurfAceLocklessRuntimeAdapter(store: store, legacy: legacy), store)
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
