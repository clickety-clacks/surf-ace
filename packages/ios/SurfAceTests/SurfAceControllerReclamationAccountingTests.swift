import Foundation
import XCTest
@testable import SurfAce

final class SurfAceControllerReclamationAccountingTests: XCTestCase {
    func testRestartTwelveDormantTwoLivePreservesRetainedMaterialAndOrderedEvents() throws {
        let before = try fixture()
        let store = try temporaryStore(before)
        _ = try SurfAceLocklessRuntimeAdapter(store: store)
        let after = try XCTUnwrap(store.load())
        try after.validate()
        let removed: Set<String> = ["controller-01", "controller-02"]
        XCTAssertEqual(Set(after.controllers.keys), Set(before.controllers.keys).subtracting(removed))
        XCTAssertTrue(after.controllers.values.allSatisfy { $0.status == .dormant })
        XCTAssertEqual(after.controllers["controller-13"]?.dormantSequence, 13)
        XCTAssertEqual(after.controllers["controller-14"]?.dormantSequence, 14)
        XCTAssertEqual(after.generation, before.generation + 1)
        XCTAssertEqual(after.sequences.nextDormantSequence, 15)
        XCTAssertEqual(after.sequences.nextCommitSequence, before.sequences.nextCommitSequence + 2)
        try assertMaterialPreserved(before, after, removed: removed)
        let events = try XCTUnwrap(after.pendingControllerRetentionReclamations)
        XCTAssertEqual(events.map(\.controllerInstanceId), ["controller-01", "controller-02"])
        XCTAssertEqual(events.map(\.dormantSequence), [1, 2])
        XCTAssertEqual(events.map(\.commitSequence), [before.sequences.nextCommitSequence, before.sequences.nextCommitSequence + 1])
        XCTAssertEqual(Set(events.map(\.eventId)).count, 2)
        XCTAssertTrue(events.allSatisfy { $0.trigger == "restored_state_enforcement" && $0.reason == "count_capacity" })
        XCTAssertTrue(events.allSatisfy { $0.recipientControllerInstanceIds.isEmpty && $0.deliveredControllerInstanceIds.isEmpty })
        XCTAssertTrue(events.allSatisfy { $0.tombstoneCursorCount > 0 && $0.liveCursorCount > 0 })
        // A second startup must neither repeat reclamation nor change its durable events.
        let bytes = try Data(contentsOf: store.stateURL)
        _ = try SurfAceLocklessRuntimeAdapter(store: store)
        XCTAssertEqual(try store.load(), after)
        XCTAssertEqual(try Data(contentsOf: store.stateURL), bytes)
    }

    func testOrdinaryReclamationRefreshesNestedAccountingAndPreservesLiveRecipients() throws {
        let before = try fixture()
        var after = before
        let event = try XCTUnwrap(SurfAceLocklessDormantRetention.reclaimOldest(in: &after))
        try after.validate()
        XCTAssertEqual(event.controllerInstanceId, "controller-01")
        XCTAssertEqual(event.recipientControllerInstanceIds, ["controller-13", "controller-14"])
        XCTAssertEqual(event.deliveredControllerInstanceIds, [])
        XCTAssertEqual(after.pendingControllerRetentionReclamations, [event])
        for id in after.controllers.keys { XCTAssertEqual(after.controllers[id], before.controllers[id]) }
        try assertMaterialPreserved(before, after, removed: ["controller-01"])
        let store = try temporaryStore(after)
        XCTAssertEqual(try store.load(), after)
    }

    func testNoPressureStartupLeavesExactDurableStateUntouched() throws {
        var before = try fixture()
        // Keep the two extra controllers dormant within a larger admitted limit;
        // there is no restart conversion or reclamation in this condition.
        before.limits.maxDormantControllerEntries = 14
        for (offset, id) in ["controller-13", "controller-14"].enumerated() {
            before.controllers[id]?.status = .dormant
            before.controllers[id]?.dormantSequence = Int64(13 + offset)
        }
        before.sequences.nextDormantSequence = 15
        let store = try temporaryStore(before)
        let bytes = try Data(contentsOf: store.stateURL)
        _ = try SurfAceLocklessRuntimeAdapter(store: store)
        XCTAssertEqual(try store.load(), before)
        XCTAssertEqual(try Data(contentsOf: store.stateURL), bytes)
    }

    func testInvalidInputAccountingIsStillRejectedBeforeStartupWrites() throws {
        var before = try fixture()
        let id = try XCTUnwrap(before.liveSurfaces.keys.first)
        before.liveSurfaces[id]?.paneTombstones[0].bytes += 1
        let directory = try temporaryDirectory()
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("invalid.json"))
        let bytes = try JSONEncoder().encode(before)
        try bytes.write(to: store.stateURL)
        XCTAssertThrowsError(try SurfAceLocklessRuntimeAdapter(store: store)) { error in
            guard case SurfAceLocklessAuthorityError.invalidState(let reason) = error else {
                return XCTFail("Unexpected error: \(error)")
            }
            XCTAssertTrue(reason.hasPrefix("pane_tombstone_exact_bytes:"))
        }
        XCTAssertEqual(try Data(contentsOf: store.stateURL), bytes)
    }

    private func fixture() throws -> SurfAceLocklessAuthorityState {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxAnnotationPublisherStateBytesPerSurface = Int64(SurfAceAnnotationOutbox.maximumBytes)
        limits.maxAnnotationPublisherRecordsPerSurface = Int64(SurfAceAnnotationOutbox.maximumRecords)
        limits.maxRecoverableSurfaceBytes = 704 * 1_024 * 1_024
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        state.annotationPublisher = try SurfAceAnnotationOutbox(
            clientId: "fixture-client", sourceEpoch: "0123456789abcdef0123456789abcdef")
        for index in 1...14 {
            let id = String(format: "controller-%02d", index)
            state.controllers[id] = .init(
                controllerInstanceId: id, controllerProductName: "retention-fixture",
                disconnectedAt: index <= 12 ? Int64(index) : nil,
                dormantSequence: index <= 12 ? Int64(index) : nil,
                pendingOperationReceipts: [:], projectionCapacityBytes: 8 * 1_024 * 1_024,
                status: index <= 12 ? .dormant : .live)
        }
        state.sequences.nextDormantSequence = 13
        for ordinal in 0..<2 {
            let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
                state: &state, expectedSurfaceSetRevision: state.surfaceSetRevision)
            let id = opened.surface.surfaceId
            _ = try SurfAceLocklessTopologyOperations.paneSplit(
                state: &state, surfaceId: id, paneId: 1, count: 4,
                direction: "horizontal", expectedTopologyRevision: 0)
            for paneId in 1...4 {
                var pane = try XCTUnwrap(state.liveSurfaces[id]?.panes[String(paneId)])
                var back = pane.history.visible
                back.content = .string("prior content \(ordinal)/\(paneId)")
                back.historyEntryId = "back-\(ordinal)-\(paneId)"
                pane.history.back = [back]
                pane.history.visible.content = .string("useful content \(ordinal)/\(paneId)")
                pane.history.visible.annotations = .object(["preserved": .bool(true)])
                pane.history.visible.provenance.friendlyChatName = "keep-history"
                state.liveSurfaces[id]?.panes[String(paneId)] = pane
            }
            // Exercise live pane/surface scopes and both retained tombstone levels.
            for scopeId in state.scopes.keys.sorted() where state.scopes[scopeId]?.records.isEmpty == true {
                let kind = try XCTUnwrap(state.scopes[scopeId]?.scopeKind)
                for number in 1...2 {
                    _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
                        in: &state, scopeId: scopeId, scopeKind: kind,
                        recordId: "\(scopeId)-\(number)", recordClass: .content,
                        payload: .string("retained record \(number)"))
                }
                // Record1 is held solely by the oldest victim; record2 by all others.
                for controllerId in state.scopes[scopeId]!.cursors.keys where controllerId != "controller-01" {
                    state.scopes[scopeId]?.cursors[controllerId]?.cursor = 2
                }
                state.scopes[scopeId]?.cursors["controller-03"]?.gapGeneration = 1
                state.scopes[scopeId]?.cursors["controller-03"]?.gap = .init(
                    cause: "scope_capacity", droppedBytes: 1, droppedEventCount: 1,
                    droppedFrameCount: 0, droppedRecordCount: 1, firstLostSequence: 1,
                    generation: 1, lastLostSequence: 1, lossExtent: "exact", recordClasses: [.content])
            }
            _ = try state.annotationPublisher?.beginFrame(
                surfaceId: id, paneId: 1, contextKey: "fixture-content", contentId: "fixture-content",
                url: nil, scrollOffset: .init(x: 0, y: 0),
                viewport: .init(width: 100, height: 80, scale: 2), openedAt: 1000, image: "aW1hZ2U=")
            for paneId in 2...4 {
                _ = try SurfAceLocklessTopologyOperations.paneClose(
                    state: &state, surfaceId: id, paneId: Int64(paneId),
                    expectedTopologyRevision: try XCTUnwrap(state.liveSurfaces[id]?.topologyRevision))
            }
            if ordinal == 1 {
                _ = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
                    state: &state, surfaceId: id, expectedSurfaceSetRevision: state.surfaceSetRevision,
                    expectedTopologyRevision: try XCTUnwrap(state.liveSurfaces[id]?.topologyRevision))
            }
        }
        try state.validate()
        return state
    }

    private func assertMaterialPreserved(
        _ before: SurfAceLocklessAuthorityState, _ after: SurfAceLocklessAuthorityState,
        removed: Set<String>, file: StaticString = #filePath, line: UInt = #line
    ) throws {
        XCTAssertEqual(after.annotationPublisher, before.annotationPublisher, file: file, line: line)
        XCTAssertEqual(after.surfaceSetRevision, before.surfaceSetRevision, file: file, line: line)
        XCTAssertEqual(after.sceneSurfaceIds, before.sceneSurfaceIds, file: file, line: line)
        XCTAssertEqual(after.registryBinding, before.registryBinding, file: file, line: line)
        XCTAssertEqual(after.sequences.nextClosedSequence, before.sequences.nextClosedSequence, file: file, line: line)
        XCTAssertEqual(after.pendingTombstoneReclamations, before.pendingTombstoneReclamations, file: file, line: line)
        let beforeScopes = Dictionary(uniqueKeysWithValues: SurfAceLocklessDormantRetention.allScopes(in: before))
        let afterScopes = Dictionary(uniqueKeysWithValues: SurfAceLocklessDormantRetention.allScopes(in: after))
        XCTAssertEqual(Set(beforeScopes.keys), Set(afterScopes.keys), file: file, line: line)
        for (path, scope) in beforeScopes {
            var expected = scope
            expected.cursors = scope.cursors.filter { !removed.contains($0.key) }
            expected.records = Array(scope.records.dropFirst())
            XCTAssertEqual(afterScopes[path], expected, path, file: file, line: line)
        }
        // Compare complete retained/live material, allowing only scope cleanup and
        // accounting fields already checked by validate(), never content/history loss.
        func material(_ state: SurfAceLocklessAuthorityState) -> [String: SurfAceLocklessSurfaceMaterial] {
            var surfaces = state.liveSurfaces
            for tombstone in state.surfaceTombstones { surfaces[tombstone.surface.surfaceId] = tombstone.surface }
            return surfaces.mapValues { surface in
                var copy = surface
                for index in copy.paneTombstones.indices {
                    copy.paneTombstones[index].bytes = 0
                    copy.paneTombstones[index].scope.cursors = [:]
                    copy.paneTombstones[index].scope.records = []
                }
                return copy
            }
        }
        XCTAssertEqual(material(after), material(before), file: file, line: line)
        XCTAssertEqual(after.surfaceTombstones.map(\.tombstoneId), before.surfaceTombstones.map(\.tombstoneId), file: file, line: line)
        XCTAssertEqual(after.surfaceTombstones.map(\.closedSequence), before.surfaceTombstones.map(\.closedSequence), file: file, line: line)
        XCTAssertEqual(Set(after.liveSurfaces.keys), Set(before.liveSurfaces.keys), file: file, line: line)
    }

    private func temporaryDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("ReclamationAccounting-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: url) }
        return url
    }

    private func temporaryStore(_ state: SurfAceLocklessAuthorityState) throws -> SurfAceLocklessGenerationStore {
        let store = SurfAceLocklessGenerationStore(stateURL: try temporaryDirectory().appendingPathComponent("authority.json"))
        try store.save(state)
        return store
    }
}
