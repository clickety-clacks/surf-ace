import XCTest
@testable import SurfAce

final class SurfAceLocklessTopologyOperationsTests: XCTestCase {
    func testSameRevisionCommitsExactlyOneMutationAndReturnsCurrentTreeToLoser() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        )

        let split = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: opened.surface.surfaceId, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        XCTAssertEqual(split.topologyRevision, 1)
        let afterWinner = state

        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.paneRename(
            state: &state, surfaceId: opened.surface.surfaceId, paneId: 1,
            name: "loser", expectedTopologyRevision: 0
        )) { error in
            XCTAssertEqual(
                error as? SurfAceLocklessTopologyOperationError,
                .staleTopology(currentRevision: 1, currentTopology: split.topology)
            )
        }
        XCTAssertEqual(state, afterWinner)
    }

    func testPaneCloseRestorePreservesIdentityStateAndAllocatesConflictingLabel() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let split = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: surfaceId, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        let closedPaneId = try XCTUnwrap(split.newPaneIds.first)
        let original = try XCTUnwrap(state.liveSurfaces[surfaceId]?.panes[String(closedPaneId)])
        let close = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: closedPaneId, expectedTopologyRevision: 1
        )
        state.liveSurfaces[surfaceId]?.panes["1"]?.paneLabel = original.paneLabel

        let restored = try SurfAceLocklessTopologyOperations.paneRestore(
            state: &state, surfaceId: surfaceId, tombstoneId: close.tombstoneId,
            anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: 2
        )

        XCTAssertEqual(restored.paneId, original.paneId)
        XCTAssertNotEqual(restored.paneLabel, original.paneLabel)
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.panes[String(closedPaneId)]?.history, original.history)
        XCTAssertTrue(state.liveSurfaces[surfaceId]?.paneTombstones.isEmpty == true)
    }

    func testCloseLastPaneIsIdentityNeutralAndAtomic() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let before = state
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: 1, expectedTopologyRevision: 0
        )) { error in
            XCTAssertEqual(error as? SurfAceLocklessTopologyOperationError, .lastLivePane)
        }
        XCTAssertEqual(state, before)
    }

    func testTopologyApplyAllocatesClientIdsAndRequiresExplicitDestruction() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let desired: SurfAceLocklessJSON = .object([
            "children": .array([
                .object(["paneId": .integer(1), "type": .string("pane")]),
                .object(["type": .string("pane")]),
            ]),
            "direction": .string("horizontal"), "type": .string("split"),
        ])
        let result = try SurfAceLocklessTopologyOperations.topologyApply(
            state: &state, surfaceId: surfaceId, targetPaneId: nil, desired: desired,
            allowDestroyPaneIds: [], expectedTopologyRevision: 0
        )
        XCTAssertEqual(result.createdPaneIds.count, 1)
        XCTAssertEqual(result.preservedPaneIds, [1])
        XCTAssertEqual(result.topologyRevision, 1)

        let before = state
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.topologyApply(
            state: &state, surfaceId: surfaceId, targetPaneId: nil,
            desired: .object(["paneId": .integer(1), "type": .string("pane")]),
            allowDestroyPaneIds: [], expectedTopologyRevision: 1
        )) { error in
            XCTAssertEqual(error as? SurfAceLocklessTopologyOperationError, .invalidTopology("destroy_not_allowed"))
        }
        XCTAssertEqual(state, before)
    }

    func testSharedTombstonePoolReclaimsOldestClosedSequence() throws {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxRetainedTombstones = 1
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let split = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: surfaceId, paneId: 1, count: 3,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        let first = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: split.newPaneIds[0], expectedTopologyRevision: 1
        )
        let second = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: split.newPaneIds[1], expectedTopologyRevision: 2
        )
        XCTAssertEqual(second.reclamations.map(\.tombstoneId), [first.tombstoneId])
        XCTAssertEqual(second.reclamations.map(\.reason), [.countCapacity])
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.paneTombstones.map(\.tombstoneId), [second.tombstoneId])
    }

    func testSurfaceCloseRestorePreservesStableIdsAndAllNestedMaterial() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0, placement: .object(["display": .string("main")])
        )
        let surfaceId = opened.surface.surfaceId
        _ = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: surfaceId, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        let expectedSurface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        let close = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: surfaceId, expectedSurfaceSetRevision: 1,
            expectedTopologyRevision: 1
        )
        XCTAssertNil(state.liveSurfaces[surfaceId])
        XCTAssertEqual(state.surfaceSetRevision, 2)

        let restored = try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &state, tombstoneId: close.tombstoneId, expectedSurfaceSetRevision: 2
        )
        XCTAssertEqual(restored.surface.surfaceId, expectedSurface.surfaceId)
        XCTAssertEqual(restored.surface.panes, expectedSurface.panes)
        XCTAssertEqual(restored.surface.topology, expectedSurface.topology)
        XCTAssertEqual(restored.surfaceSetRevision, 3)
        XCTAssertTrue(state.surfaceTombstones.isEmpty)
    }
}
