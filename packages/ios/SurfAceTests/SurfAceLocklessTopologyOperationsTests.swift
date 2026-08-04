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

private extension SurfAceLocklessTopologyOperationsTests {
    func liveController(_ id: String) -> SurfAceLocklessControllerBundle {
        SurfAceLocklessControllerBundle(
            controllerInstanceId: id, controllerProductName: nil,
            disconnectedAt: nil, dormantSequence: nil, pendingOperationReceipts: [:],
            projectionCapacityBytes: 8_388_608, status: .live
        )
    }

    func populatedPaneCloseFixture(
        maxPanes: Int64 = 16,
        maxTombstones: Int64 = 32
    ) throws -> SurfAceLocklessAuthorityState {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxPanesPerSurface = maxPanes
        limits.maxRetainedTombstones = maxTombstones
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        for id in ["controller-a", "controller-b"] {
            state.controllers[id] = SurfAceLocklessControllerBundle(
                controllerInstanceId: id, controllerProductName: "Same Label",
                disconnectedAt: nil, dormantSequence: nil, pendingOperationReceipts: [:],
                projectionCapacityBytes: 8_388_608, status: .live
            )
        }
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        )
        let allocatedId = opened.surface.surfaceId
        var surface = try XCTUnwrap(state.liveSurfaces.removeValue(forKey: allocatedId))
        surface.surfaceId = "sf_1"
        surface.topology = .object(["paneId": .integer(1), "type": .string("pane")])
        state.liveSurfaces["sf_1"] = surface
        let encoded = allocatedId.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? allocatedId
        if var scope = state.scopes.removeValue(forKey: "surface:\(encoded)") {
            scope.scopeId = "surface:sf%5F1"
            state.scopes[scope.scopeId] = scope
        }
        if var scope = state.scopes.removeValue(forKey: "pane:\(encoded):1") {
            scope.scopeId = "pane:sf%5F1:1"
            state.scopes[scope.scopeId] = scope
        }
        _ = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: "sf_1", paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        var pane = try XCTUnwrap(state.liveSurfaces["sf_1"]?.panes["2"])
        func entry(_ id: String, revision: Int64, product: String) -> SurfAceLocklessHistoryEntry {
            SurfAceLocklessHistoryEntry(
                annotations: .object(["drawingData": .string("drawing-\(id)"), "strokesById": .object([id: .string("stroke")])]),
                content: .object(["markdown": .string(id)]), contentId: id,
                contentType: "markdown", historyEntryId: "he_\(id)",
                lastVisibleSequence: revision,
                provenance: .init(friendlyChatName: "chat-\(id)", controllerProductName: product),
                revision: revision
            )
        }
        pane.history = .init(
            back: [entry("A1", revision: 1, product: "A")],
            forward: [entry("A2", revision: 3, product: "A")],
            nextRevision: 4, nextVisibleSequence: 4,
            visible: entry("B1", revision: 2, product: "B")
        )
        state.liveSurfaces["sf_1"]?.panes["2"] = pane
        _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state, scopeId: "pane:sf%5F1:2", scopeKind: "pane",
            recordId: "mixed-unread", recordClass: .content,
            payload: .object(["entry": .string("B1")])
        )
        try state.validate()
        return state
    }

    func bytePressureAuthority() throws -> SurfAceLocklessAuthorityState {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxPanesPerSurface = 1
        limits.maxSurfaceRecoverableBaseBytes = 50_000
        limits.maxPaneRecoverableStateBytes = 2_000
        limits.maxPaneAnnotationRestoreBytes = 1_000
        limits.maxRetainedTombstones = 3
        limits.maxRetainedTombstoneBytes = 120_000
        limits.maxRecoverableSurfaceBytes = 60_000
        limits.maxPaneConsumableRecords = 1
        limits.maxPaneConsumableBytes = 100
        limits.maxSurfaceConsumableRecords = 1
        limits.maxSurfaceConsumableBytes = 100
        limits.maxConsumableRecordBytes = 50
        limits.maxConsumableCursorStateBytesPerScope = 200
        limits.maxAdmittedControllerEntries = 1
        return try SurfAceLocklessAuthorityState.empty(limits: limits)
    }
}

extension SurfAceLocklessTopologyOperationsTests {
    func testACSURF01ControllerAndLocalOpenShareStableCallerNeutralLifecycleSeam() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        state.controllers["controller-a"] = liveController("controller-a")
        state.controllers["controller-b"] = liveController("controller-b")
        let controllerOpen = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        )
        let localOpen = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 1
        )
        XCTAssertNotEqual(controllerOpen.surface.surfaceId, localOpen.surface.surfaceId)
        XCTAssertNotEqual(controllerOpen.surface.windowLabel, localOpen.surface.windowLabel)
        XCTAssertEqual(controllerOpen.surface.panes.values.first?.paneId, 1)
        XCTAssertEqual(localOpen.surface.panes.values.first?.paneId, 1)
        XCTAssertEqual(state.surfaceSetRevision, 2)
        XCTAssertTrue(state.scopes.values.allSatisfy {
            Set($0.cursors.keys) == ["controller-a", "controller-b"]
        })
        XCTAssertTrue(SurfAceLocklessTargetAdmission.requiredNetworkOperations.contains("surface.window.open"))
        XCTAssertTrue(SurfAceLocklessTargetAdmission.localLifecycleComplete)
    }

    func testACSURF02SurfaceCloseRestorePreservesNestedTombstonesHistoryAndUnreadScopes() throws {
        var state = try populatedPaneCloseFixture()
        let paneClose = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: "sf_1", paneId: 2, expectedTopologyRevision: 1
        )
        _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state, scopeId: "surface:sf%5F1", scopeKind: "surface",
            recordId: "surface-unread", recordClass: .topology, payload: .string("unread")
        )
        let before = try XCTUnwrap(state.liveSurfaces["sf_1"])
        let beforeSurfaceScope = try XCTUnwrap(state.scopes["surface:sf%5F1"])
        let close = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: "sf_1",
            expectedSurfaceSetRevision: 1, expectedTopologyRevision: 2
        )
        XCTAssertNil(state.liveSurfaces["sf_1"])
        let tombstone = try XCTUnwrap(state.surfaceTombstones.first)
        XCTAssertEqual(tombstone.surface, before)
        XCTAssertEqual(tombstone.surface.paneTombstones.first?.tombstoneId, paneClose.tombstoneId)
        XCTAssertEqual(tombstone.scopes["surface:sf%5F1"], beforeSurfaceScope)
        let restored = try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &state, tombstoneId: close.tombstoneId, expectedSurfaceSetRevision: 2
        )
        XCTAssertEqual(restored.surface, before)
        XCTAssertEqual(state.scopes["surface:sf%5F1"], beforeSurfaceScope)
    }

    func testACSURF03LastLocalSurfaceCloseKeepsZeroLiveEndpointAndCallerNeutralRestore() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        )
        let close = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: opened.surface.surfaceId,
            expectedSurfaceSetRevision: 1, expectedTopologyRevision: 0
        )
        XCTAssertTrue(state.liveSurfaces.isEmpty)
        XCTAssertEqual(state.capability, surfAceLocklessCapability)
        XCTAssertEqual(state.surfaceTombstones.count, 1)
        let restoredByController = try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &state, tombstoneId: close.tombstoneId, expectedSurfaceSetRevision: 2
        )
        let reclosed = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: restoredByController.surface.surfaceId,
            expectedSurfaceSetRevision: 3, expectedTopologyRevision: 0
        )
        let restoredByUser = try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &state, tombstoneId: reclosed.tombstoneId, expectedSurfaceSetRevision: 4
        )
        XCTAssertEqual(restoredByUser.surface.surfaceId, opened.surface.surfaceId)
        XCTAssertEqual(restoredByUser.surface.panes, opened.surface.panes)
    }

    func testACSURF04ConcurrentLifecycleLosersRemainAtomicUntilFreshRevisionRetry() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let winner = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        )
        let afterWinner = state
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        )) { error in
            XCTAssertEqual(error as? SurfAceLocklessTopologyOperationError, .staleSurfaceSet(currentRevision: 1))
        }
        XCTAssertEqual(state, afterWinner)
        let close = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: winner.surface.surfaceId,
            expectedSurfaceSetRevision: 1, expectedTopologyRevision: 0
        )
        let afterClose = state
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &state, tombstoneId: close.tombstoneId, expectedSurfaceSetRevision: 1
        ))
        XCTAssertEqual(state, afterClose)
        XCTAssertNoThrow(try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &state, tombstoneId: close.tombstoneId, expectedSurfaceSetRevision: 2
        ))
    }

    func testACSURF05SurfaceCloseCountsNestedStateOnceAndPreservesExistingGap() throws {
        var state = try populatedPaneCloseFixture()
        let paneClose = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: "sf_1", paneId: 2, expectedTopologyRevision: 1
        )
        var surfaceScope = try XCTUnwrap(state.scopes["surface:sf%5F1"])
        surfaceScope.cursors["controller-a"]?.gap = SurfAceLocklessConsumableGap(
            cause: "scope_capacity", droppedBytes: 10, droppedEventCount: 1,
            droppedFrameCount: 0, droppedRecordCount: 1,
            firstLostSequence: 1, generation: 1, lastLostSequence: 1,
            lossExtent: "known", recordClasses: [.topology]
        )
        surfaceScope.cursors["controller-a"]?.gapGeneration = 1
        state.scopes[surfaceScope.scopeId] = surfaceScope
        let sequence = state.sequences.nextClosedSequence
        let close = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: "sf_1",
            expectedSurfaceSetRevision: 1, expectedTopologyRevision: 2
        )
        let tombstone = try XCTUnwrap(state.surfaceTombstones.first)
        XCTAssertEqual(close.closedSequence, sequence)
        XCTAssertEqual(tombstone.surface.paneTombstones.map(\.tombstoneId), [paneClose.tombstoneId])
        XCTAssertEqual(tombstone.scopes[surfaceScope.scopeId]?.cursors["controller-a"]?.gap, surfaceScope.cursors["controller-a"]?.gap)
        XCTAssertEqual(tombstone.scopes[surfaceScope.scopeId]?.cursors["controller-a"]?.cursor,
                       surfaceScope.cursors["controller-a"]?.cursor)
    }

    func testACSURF06ZeroLiveOverPGenerationRestoresBeforeCreationAdmission() throws {
        var state = try populatedPaneCloseFixture(maxPanes: 2, maxTombstones: 2)
        let closePane = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: "sf_1", paneId: 2, expectedTopologyRevision: 1
        )
        _ = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: "sf_1", paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 2
        )
        _ = try SurfAceLocklessTopologyOperations.paneRestore(
            state: &state, surfaceId: "sf_1", tombstoneId: closePane.tombstoneId,
            anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: 3
        )
        XCTAssertEqual(state.liveSurfaces["sf_1"]?.panes.count, 3)
        let surfaceClose = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: "sf_1",
            expectedSurfaceSetRevision: 1, expectedTopologyRevision: 4
        )
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("ACSURF06-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        try store.save(state)
        var restoredState = try XCTUnwrap(store.load())
        XCTAssertTrue(restoredState.liveSurfaces.isEmpty)
        XCTAssertEqual(restoredState.surfaceTombstones.first?.surface.panes.count, 3)
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &restoredState, tombstoneId: surfaceClose.tombstoneId,
            expectedSurfaceSetRevision: 2
        )
        XCTAssertEqual(restoredState.liveSurfaces["sf_1"]?.panes.count, 3)
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.paneSplit(
            state: &restoredState, surfaceId: "sf_1", paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 4
        )) { error in
            XCTAssertEqual(error as? SurfAceLocklessTopologyOperationError,
                           .paneCapacity(current: 3, requested: 4, maximum: 2))
        }
    }

    func testACCAP02ExactPaneAnnotationAndSurfaceBaseBoundsAreAtomicAndRestorable() throws {
        var state = try populatedPaneCloseFixture()
        let surfaceId = "sf_1"
        let pane = try XCTUnwrap(state.liveSurfaces[surfaceId]?.panes["2"])
        let paneBytes = try SurfAceLocklessContentOperations.exactPaneRecoverableBytes(pane)
        let annotationBytes = try SurfAceLocklessContentOperations.exactAnnotationRestoreBytes(pane)
        state.limits.maxPaneRecoverableStateBytes = paneBytes
        state.limits.maxPaneAnnotationRestoreBytes = annotationBytes
        let original = state
        let closed = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: 2, expectedTopologyRevision: 1
        )
        _ = try SurfAceLocklessTopologyOperations.paneRestore(
            state: &state, surfaceId: surfaceId, tombstoneId: closed.tombstoneId,
            anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: 2
        )
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.panes["2"], original.liveSurfaces[surfaceId]?.panes["2"])

        let baseBytes = try SurfAceLocklessTopologyOperations.surfaceBaseBytes(
            try XCTUnwrap(state.liveSurfaces[surfaceId])
        )
        state.limits.maxSurfaceRecoverableBaseBytes = baseBytes
        XCTAssertNoThrow(try state.validate())
        var tooSmall = state
        tooSmall.limits.maxSurfaceRecoverableBaseBytes = baseBytes - 1
        XCTAssertThrowsError(try tooSmall.validate())
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.panes["2"], original.liveSurfaces[surfaceId]?.panes["2"])
    }

    func testACCLOSE01CloseAtomicallyPreservesMixedHistoryProvenanceAnnotationsAndUnreadCursors() throws {
        var state = try populatedPaneCloseFixture()
        let originalPane = try XCTUnwrap(state.liveSurfaces["sf_1"]?.panes["2"])
        let originalScope = try XCTUnwrap(state.scopes["pane:sf%5F1:2"])
        let beforeSequence = state.sequences.nextClosedSequence
        let result = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: "sf_1", paneId: 2, expectedTopologyRevision: 1
        )
        let tombstone = try XCTUnwrap(state.liveSurfaces["sf_1"]?.paneTombstones.first)
        XCTAssertEqual(result.closedSequence, beforeSequence)
        XCTAssertEqual(tombstone.pane, originalPane)
        XCTAssertEqual(tombstone.scope, originalScope)
        XCTAssertNil(state.liveSurfaces["sf_1"]?.panes["2"])
        XCTAssertNil(state.scopes[originalScope.scopeId])
        XCTAssertEqual(tombstone.scope.cursors["controller-a"]?.cursor, 1)
        XCTAssertEqual(tombstone.scope.cursors["controller-b"]?.cursor, 1)
        XCTAssertEqual(tombstone.scope.records.map(\.recordId), ["mixed-unread"])
    }

    func testACCLOSE02AnyControllerRestoresExactPaneAtAndAboveCreationCap() throws {
        var state = try populatedPaneCloseFixture(maxPanes: 2, maxTombstones: 2)
        let originalPane = try XCTUnwrap(state.liveSurfaces["sf_1"]?.panes["2"])
        let originalScope = try XCTUnwrap(state.scopes["pane:sf%5F1:2"])
        let close = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: "sf_1", paneId: 2, expectedTopologyRevision: 1
        )
        _ = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: "sf_1", paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 2
        )
        XCTAssertEqual(state.liveSurfaces["sf_1"]?.panes.count, 2)
        let restored = try SurfAceLocklessTopologyOperations.paneRestore(
            state: &state, surfaceId: "sf_1", tombstoneId: close.tombstoneId,
            anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: 3
        )
        XCTAssertEqual(restored.paneId, originalPane.paneId)
        XCTAssertEqual(state.liveSurfaces["sf_1"]?.panes["2"]?.history, originalPane.history)
        XCTAssertEqual(state.scopes[originalScope.scopeId], originalScope)
        XCTAssertEqual(state.liveSurfaces["sf_1"]?.panes.count, 3)
        XCTAssertTrue(state.liveSurfaces["sf_1"]?.paneTombstones.isEmpty == true)
    }

    func testACCLOSE06GlobalCountAndBytePressureReclaimsAscendingClosedSequence() throws {
        var countLimits = SurfAceLocklessCapacityLimits.production
        countLimits.maxRetainedTombstones = 1
        var countState = try SurfAceLocklessAuthorityState.empty(limits: countLimits)
        let firstId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &countState, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let first = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &countState, surfaceId: firstId,
            expectedSurfaceSetRevision: 1, expectedTopologyRevision: 0
        )
        let secondId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &countState, expectedSurfaceSetRevision: 2
        ).surface.surfaceId
        let second = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &countState, surfaceId: secondId,
            expectedSurfaceSetRevision: 3, expectedTopologyRevision: 0
        )
        XCTAssertEqual(second.reclamations.map(\.tombstoneId), [first.tombstoneId])
        XCTAssertEqual(second.reclamations.map(\.reason), [.countCapacity])

        var byteState = try bytePressureAuthority()
        var closed: [SurfAceLocklessSurfaceCloseResult] = []
        for index in 0..<3 {
            let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
                state: &byteState, expectedSurfaceSetRevision: Int64(index * 2),
                placement: .string(String(repeating: Character("a"), count: 45_000))
            )
            closed.append(try SurfAceLocklessTopologyOperations.surfaceWindowClose(
                state: &byteState, surfaceId: opened.surface.surfaceId,
                expectedSurfaceSetRevision: Int64(index * 2 + 1), expectedTopologyRevision: 0
            ))
        }
        XCTAssertEqual(closed.last?.reclamations.first?.closedSequence, closed.first?.closedSequence)
        XCTAssertEqual(closed.last?.reclamations.first?.reason, .byteCapacity)
        XCTAssertLessThanOrEqual(
            byteState.surfaceTombstones.reduce(Int64(0)) { $0 + $1.bytes },
            byteState.limits.maxRetainedTombstoneBytes
        )
    }

    func testACCLOSE08ReadsAndFailedRestoreDoNotRefreshReclamationOrder() throws {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxRetainedTombstones = 1
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        let firstSurface = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let first = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: firstSurface,
            expectedSurfaceSetRevision: 1, expectedTopologyRevision: 0
        )
        let observed = state.surfaceTombstones.first
        XCTAssertEqual(observed?.tombstoneId, first.tombstoneId)
        let secondSurface = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 2
        ).surface.surfaceId
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: secondSurface,
            expectedSurfaceSetRevision: 3, expectedTopologyRevision: 0
        )
        XCTAssertFalse(state.surfaceTombstones.contains { $0.tombstoneId == first.tombstoneId })
        let before = state
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &state, tombstoneId: first.tombstoneId,
            expectedSurfaceSetRevision: state.surfaceSetRevision
        )) { error in
            XCTAssertEqual(error as? SurfAceLocklessTopologyOperationError, .tombstoneNotFound(first.tombstoneId))
        }
        XCTAssertEqual(state, before)
    }

    func testACCLOSE09ReclamationDiagnosticsContainStableIdentityBoundsAndReason() throws {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxRetainedTombstones = 1
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        let firstId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let first = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: firstId,
            expectedSurfaceSetRevision: 1, expectedTopologyRevision: 0
        )
        let secondId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 2
        ).surface.surfaceId
        let close = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: secondId,
            expectedSurfaceSetRevision: 3, expectedTopologyRevision: 0
        )
        let diagnostic = try XCTUnwrap(close.reclamations.first)
        XCTAssertEqual(diagnostic.tombstoneId, first.tombstoneId)
        XCTAssertEqual(diagnostic.surfaceId, firstId)
        XCTAssertEqual(diagnostic.closedSequence, first.closedSequence)
        XCTAssertGreaterThan(diagnostic.bytes, 0)
        XCTAssertEqual(diagnostic.reason, .countCapacity)
        XCTAssertEqual(diagnostic.maxRetainedTombstones, 1)
        XCTAssertEqual(diagnostic.maxRetainedTombstoneBytes, state.limits.maxRetainedTombstoneBytes)
        XCTAssertEqual(diagnostic.nestedLivePaneCount, 1)
        XCTAssertEqual(diagnostic.nestedPaneTombstoneCount, 0)
        XCTAssertEqual(diagnostic.unreadFrameCount, 0)
        XCTAssertEqual(diagnostic.recipientControllerInstanceIds, [])
        XCTAssertEqual(state.pendingTombstoneReclamations, [diagnostic])
    }

    func testACCAP01CreationCapRetainedConservationAndCapacityFreeRestore() throws {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxPanesPerSurface = 3
        limits.maxRetainedTombstones = 2
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        let id = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let filled = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 3,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        XCTAssertEqual(state.liveSurfaces[id]?.panes.count, 3)
        let beforeRefusal = state
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 2,
            direction: "vertical", expectedTopologyRevision: 1
        )) { error in
            XCTAssertEqual(error as? SurfAceLocklessTopologyOperationError,
                           .paneCapacity(current: 3, requested: 4, maximum: 3))
        }
        XCTAssertEqual(state, beforeRefusal)
        let first = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: id, paneId: filled.newPaneIds[0], expectedTopologyRevision: 1
        )
        let second = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: id, paneId: filled.newPaneIds[1], expectedTopologyRevision: 2
        )
        _ = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 3,
            direction: "vertical", expectedTopologyRevision: 3
        )
        XCTAssertEqual((state.liveSurfaces[id]?.panes.count ?? 0) + (state.liveSurfaces[id]?.paneTombstones.count ?? 0), 5)
        _ = try SurfAceLocklessTopologyOperations.paneRestore(
            state: &state, surfaceId: id, tombstoneId: first.tombstoneId,
            anchorPaneId: 1, direction: "horizontal", expectedTopologyRevision: 4
        )
        _ = try SurfAceLocklessTopologyOperations.paneRestore(
            state: &state, surfaceId: id, tombstoneId: second.tombstoneId,
            anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: 5
        )
        XCTAssertEqual(state.liveSurfaces[id]?.panes.count, 5)
        XCTAssertEqual(state.liveSurfaces[id]?.paneTombstones.count, 0)
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 6
        ))
    }

    func testACCLOSE03StaleAndInvalidPlacementPreserveTombstoneUntilFreshRetry() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let id = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let split = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        let close = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: id, paneId: split.newPaneIds[0], expectedTopologyRevision: 1
        )
        let retained = state.liveSurfaces[id]?.paneTombstones
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.paneRestore(
            state: &state, surfaceId: id, tombstoneId: close.tombstoneId,
            anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: 1
        ))
        XCTAssertEqual(state.liveSurfaces[id]?.paneTombstones, retained)
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.paneRestore(
            state: &state, surfaceId: id, tombstoneId: close.tombstoneId,
            anchorPaneId: 999, direction: "diagonal", expectedTopologyRevision: 2
        ))
        XCTAssertEqual(state.liveSurfaces[id]?.paneTombstones, retained)
        XCTAssertEqual(try SurfAceLocklessTopologyOperations.paneRestore(
            state: &state, surfaceId: id, tombstoneId: close.tombstoneId,
            anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: 2
        ).paneId, split.newPaneIds[0])
    }

    func testACTOPO02StaleLoserMustRefreshRecomputeAndUseFreshRevision() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let id = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        _ = try SurfAceLocklessTopologyOperations.paneRename(
            state: &state, surfaceId: id, paneId: 1, name: "winner", expectedTopologyRevision: 0
        )
        let afterWinner = state
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.paneRename(
            state: &state, surfaceId: id, paneId: 1, name: "stale", expectedTopologyRevision: 0
        ))
        XCTAssertEqual(state, afterWinner)
        let retry = try SurfAceLocklessTopologyOperations.paneRename(
            state: &state, surfaceId: id, paneId: 1, name: "recomputed", expectedTopologyRevision: 1
        )
        XCTAssertEqual(retry.topologyRevision, 2)
        XCTAssertEqual(state.liveSurfaces[id]?.panes["1"]?.name, "recomputed")
    }

    func testACTOPO03StalePayloadIsNeverPartiallyAppliedOrRetried() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let id = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        _ = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        let before = state
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 3,
            direction: "vertical", expectedTopologyRevision: 0
        )) { error in
            guard case .staleTopology(let revision, let topology) = error as? SurfAceLocklessTopologyOperationError else {
                return XCTFail("unexpected error \(error)")
            }
            XCTAssertEqual(revision, 1)
            XCTAssertEqual(topology, before.liveSurfaces[id]?.topology)
        }
        XCTAssertEqual(state, before)
    }

    func testACTOPO04EveryOperationUsesStableIDsAndOneRevisionSeam() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let id = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let split = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        let second = try XCTUnwrap(split.newPaneIds.first)
        XCTAssertEqual(state.liveSurfaces[id]?.panes["1"]?.paneId, 1)
        let renamed = try SurfAceLocklessTopologyOperations.paneRename(
            state: &state, surfaceId: id, paneId: second, name: "two", expectedTopologyRevision: 1
        )
        XCTAssertEqual(renamed.topologyRevision, 2)
        let applied = try SurfAceLocklessTopologyOperations.topologyApply(
            state: &state, surfaceId: id, targetPaneId: nil,
            desired: split.topology, allowDestroyPaneIds: [], expectedTopologyRevision: 2
        )
        XCTAssertEqual(applied.preservedPaneIds.sorted(), [1, second])
        let closed = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: id, paneId: second, expectedTopologyRevision: 3
        )
        let restored = try SurfAceLocklessTopologyOperations.paneRestore(
            state: &state, surfaceId: id, tombstoneId: closed.tombstoneId,
            anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: 4
        )
        XCTAssertEqual(restored.paneId, second)
        XCTAssertEqual(state.liveSurfaces[id]?.panes[String(second)]?.name, "two")
    }

    func testACTOPO05AllocationFollowsSerializedReceiptOrderNotLabels() throws {
        func allocations(order: [String]) throws -> [[Int64]] {
            var state = try SurfAceLocklessAuthorityState.empty()
            let id = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
                state: &state, expectedSurfaceSetRevision: 0
            ).surface.surfaceId
            var result: [[Int64]] = []
            for (index, _) in order.enumerated() {
                result.append(try SurfAceLocklessTopologyOperations.paneSplit(
                    state: &state, surfaceId: id, paneId: 1, count: 2,
                    direction: index.isMultiple(of: 2) ? "horizontal" : "vertical",
                    expectedTopologyRevision: Int64(index)
                ).newPaneIds)
            }
            return result
        }
        XCTAssertEqual(try allocations(order: ["z", "a"]), try allocations(order: ["a", "z"]))
        XCTAssertEqual(try allocations(order: ["first", "second"]), [[2], [3]])
    }
}
