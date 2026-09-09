import Foundation
import XCTest
@testable import SurfAce

final class SurfAceReceiptReleaseTests: XCTestCase {
    func testReceiptPayloadRejectsMalformedFields() throws {
        for payload: [String: Any] in [[:], ["requestId": ""], ["requestId": 1], ["requestId": "r", "release": "true"], ["requestId": "r", "release": 1], ["requestId": "r", "release": NSNull()]] {
            XCTAssertThrowsError(try SurfAceLocklessRuntimeAdapter.receiptAcknowledgement(payload))
        }
        XCTAssertFalse(try SurfAceLocklessRuntimeAdapter.receiptAcknowledgement(["requestId": "r", "release": false]).release)
    }

    func testAcknowledgementRetainsCapturedReceiptUntilRelease() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(state: &state, expectedSurfaceSetRevision: 0)
        let surfaceId = opened.surface.surfaceId
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        _ = try await adapter.admit(controllerInstanceId: "ctl_0a3cbba278dc4d378a73e5acfb563803", controllerProductName: "Joint02 Linux Controller", connectionToken: "saved-sequence", projectionCapacityBytes: 8 * 1024 * 1024, protocolFeatures: [surfAceLocklessCapability])
        let request = "rq_ecd63e77524d4294b4ccb39a0fcb6848"
        _ = try await adapter.commitMutation(connectionToken: "saved-sequence", requestId: request, operation: "content.set") { state, sequence in
            let content = try SurfAceLocklessContentOperations.set(state: &state, intent: .init(
                content: .object(["html": .string("<html><body style=\"margin:0;background:#6a20c9;color:white\"><h1>JOINT 7AE SUPPORTED IDENTITY</h1><p>Global pane a1</p></body></html>")]),
                contentId: "joint-supported-7ae-marker", contentType: "html", controllerProductName: "Joint02 Linux Controller", friendlyChatName: "Supported iPad joint proof", paneId: 1, surfaceId: surfaceId))
            return .object(["contentId": .string(content.contentId!), "revision": .integer(content.currentRevision), "commitSequence": .integer(sequence)])
        }
        let earlyRelease = try await assertNoCommit(adapter: adapter, store: store) {
            try await adapter.acknowledgeReceipts(connectionToken: "saved-sequence", requestIds: [request], release: true)
        }
        XCTAssertFalse(earlyRelease)
        XCTAssertEqual(try store.load()?.controllers["ctl_0a3cbba278dc4d378a73e5acfb563803"]?.pendingOperationReceipts[request]?.status, .terminal)
        // Block only this test-owned temporary write path to prove failed persistence cannot acknowledge.
        let blockedWrite = root.appendingPathComponent(".state.json.next")
        try FileManager.default.createDirectory(at: blockedWrite, withIntermediateDirectories: false)
        do {
            try await adapter.acknowledgeReceipts(connectionToken: "saved-sequence", requestIds: [request])
            XCTFail("expected persistence failure")
        } catch {}
        try FileManager.default.removeItem(at: blockedWrite)
        let unchanged = await adapter.snapshot()
        XCTAssertEqual(unchanged.controllers["ctl_0a3cbba278dc4d378a73e5acfb563803"]?.pendingOperationReceipts[request]?.status, .terminal)
        let ack = try SurfAceLocklessRuntimeAdapter.receiptAcknowledgement(["requestId": request])
        try await adapter.acknowledgeReceipts(connectionToken: "saved-sequence", requestIds: [ack.requestId], release: ack.release)
        let saved = try XCTUnwrap(store.load())
        XCTAssertEqual(saved.controllers["ctl_0a3cbba278dc4d378a73e5acfb563803"]?.pendingOperationReceipts[request]?.status, .acknowledged)
        let beforeRetry = try XCTUnwrap(store.load())
        let duplicateAck = try await assertNoCommit(adapter: adapter, store: store) {
            try await adapter.acknowledgeReceipts(connectionToken: "saved-sequence", requestIds: [request], release: false)
        }
        XCTAssertTrue(duplicateAck)
        let restarted = try SurfAceLocklessRuntimeAdapter(store: store)
        _ = try await restarted.admit(controllerInstanceId: "ctl_0a3cbba278dc4d378a73e5acfb563803", controllerProductName: nil, connectionToken: "restarted", projectionCapacityBytes: 8 * 1024 * 1024, protocolFeatures: [surfAceLocklessCapability])
        XCTAssertEqual(try store.load()?.controllers["ctl_0a3cbba278dc4d378a73e5acfb563803"]?.pendingOperationReceipts[request]?.status, .acknowledged)
        let release = try SurfAceLocklessRuntimeAdapter.receiptAcknowledgement(["requestId": request, "release": true])
        let released = try await restarted.acknowledgeReceipts(connectionToken: "restarted", requestIds: [release.requestId], release: release.release)
        XCTAssertTrue(released)
        let duplicateRelease = try await assertNoCommit(adapter: restarted, store: store) {
            try await restarted.acknowledgeReceipts(connectionToken: "restarted", requestIds: [request], release: true)
        }
        XCTAssertTrue(duplicateRelease)
        let unknownAck = try await assertNoCommit(adapter: restarted, store: store) {
            try await restarted.acknowledgeReceipts(connectionToken: "restarted", requestIds: ["missing"], release: false)
        }
        XCTAssertFalse(unknownAck)
        let unknownRelease = try await assertNoCommit(adapter: restarted, store: store) {
            try await restarted.acknowledgeReceipts(connectionToken: "restarted", requestIds: ["missing"], release: true)
        }
        XCTAssertTrue(unknownRelease)
        let after = try XCTUnwrap(store.load())
        XCTAssertNil(after.controllers["ctl_0a3cbba278dc4d378a73e5acfb563803"]?.pendingOperationReceipts[request])
        XCTAssertEqual(after.liveSurfaces, beforeRetry.liveSurfaces)
        XCTAssertEqual(after.liveSurfaces[surfaceId]?.panes["1"]?.history.visible.contentId, "joint-supported-7ae-marker")
        XCTAssertEqual(after.liveSurfaces[surfaceId]?.panes["1"]?.history.visible.revision, 1)
        XCTAssertEqual(after.surfaceSetRevision, beforeRetry.surfaceSetRevision)
        XCTAssertEqual(after.sequences.nextCommitSequence, beforeRetry.sequences.nextCommitSequence)

        var pendingState = after
        var pendingReceipt = try XCTUnwrap(beforeRetry.controllers["ctl_0a3cbba278dc4d378a73e5acfb563803"]?.pendingOperationReceipts[request])
        pendingReceipt.status = .pending
        pendingReceipt.bytes = try SurfAceLocklessExactDurableAccounting.receiptBytes(pendingReceipt)
        pendingState.controllers["ctl_0a3cbba278dc4d378a73e5acfb563803"]?.pendingOperationReceipts[request] = pendingReceipt
        try store.save(pendingState)
        let pendingAdapter = try SurfAceLocklessRuntimeAdapter(store: store)
        _ = try await pendingAdapter.admit(controllerInstanceId: "ctl_0a3cbba278dc4d378a73e5acfb563803", controllerProductName: nil, connectionToken: "pending", projectionCapacityBytes: 8 * 1024 * 1024, protocolFeatures: [surfAceLocklessCapability])
        let pendingRelease = try await assertNoCommit(adapter: pendingAdapter, store: store) {
            try await pendingAdapter.acknowledgeReceipts(connectionToken: "pending", requestIds: [request], release: true)
        }
        XCTAssertTrue(pendingRelease)
        let pendingAck = try await assertNoCommit(adapter: pendingAdapter, store: store) {
            try await pendingAdapter.acknowledgeReceipts(connectionToken: "pending", requestIds: [request])
        }
        XCTAssertFalse(pendingAck)

    }

    private func assertNoCommit(adapter: SurfAceLocklessRuntimeAdapter, store: SurfAceLocklessGenerationStore,
                                operation: () async throws -> Bool) async throws -> Bool {
        let before = await adapter.snapshot()
        let bytes = try Data(contentsOf: store.stateURL)
        let accepted = try await operation()
        let after = await adapter.snapshot()
        XCTAssertEqual(after, before)
        XCTAssertEqual(after.generation, before.generation)
        XCTAssertEqual(try Data(contentsOf: store.stateURL), bytes)
        return accepted
    }
}
