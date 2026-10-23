import XCTest
import CryptoKit
@testable import SurfAce

private let allocationTestClientId = String(repeating: "a", count: 64)

// Unit fixtures inject registry results when a scenario needs assigned labels.
// Production operations may commit panes unnumbered until registry authority returns.
enum TestRegistryTopology {
    private static func nextLabel(_ state: SurfAceLocklessAuthorityState) -> Int64 {
        let labels = state.liveSurfaces.values.flatMap { surface in
            surface.panes.values.map(\.paneLabel) + surface.paneTombstones.map(\.pane.paneLabel)
        }
        return (labels.max() ?? 0) + 1
    }

    private static func identities(
        _ state: SurfAceLocklessAuthorityState, surfaceId: String, count: Int
    ) -> (labels: [Int64: Int64], lineages: [Int64: String]) {
        guard let surface = state.liveSurfaces[surfaceId] else { return ([:], [:]) }
        let occupied = Set(surface.panes.values.map(\.paneId))
            .union(surface.paneTombstones.map(\.pane.paneId))
        var nextId = surface.nextPaneId
        var nextNumber = nextLabel(state)
        var labels: [Int64: Int64] = [:]
        var lineages: [Int64: String] = [:]
        for _ in 0..<max(0, count) {
            while occupied.contains(nextId) || labels[nextId] != nil { nextId += 1 }
            labels[nextId] = nextNumber
            lineages[nextId] = "pl_test_\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
            nextId += 1
            nextNumber += 1
        }
        return (labels, lineages)
    }

    private static func newPaneCount(_ node: SurfAceLocklessJSON) -> Int {
        guard case .object(let object) = node else { return 0 }
        if case .some(.string("pane")) = object["type"] { return object["paneId"] == nil ? 1 : 0 }
        guard case .array(let children) = object["children"] else { return 0 }
        return children.reduce(0) { $0 + newPaneCount($1) }
    }

    static func paneSplit(
        state: inout SurfAceLocklessAuthorityState, surfaceId: String, paneId: Int64,
        count: Int64, direction: String, expectedTopologyRevision: Int64
    ) throws -> SurfAceLocklessPaneSplitResult {
        let claim = identities(state, surfaceId: surfaceId, count: Int(max(0, count - 1)))
        return try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: surfaceId, paneId: paneId, count: count,
            direction: direction, expectedTopologyRevision: expectedTopologyRevision,
            assignedPaneLabels: claim.labels, assignedPaneLineages: claim.lineages
        )
    }

    static func topologyApply(
        state: inout SurfAceLocklessAuthorityState, surfaceId: String,
        targetPaneId: Int64?, desired: SurfAceLocklessJSON,
        allowDestroyPaneIds: [Int64], expectedTopologyRevision: Int64
    ) throws -> SurfAceLocklessTopologyApplyResult {
        let claim = identities(state, surfaceId: surfaceId, count: newPaneCount(desired))
        return try SurfAceLocklessTopologyOperations.topologyApply(
            state: &state, surfaceId: surfaceId, targetPaneId: targetPaneId,
            desired: desired, allowDestroyPaneIds: allowDestroyPaneIds,
            expectedTopologyRevision: expectedTopologyRevision,
            assignedPaneLabels: claim.labels, assignedPaneLineages: claim.lineages
        )
    }

    static func paneRestore(
        state: inout SurfAceLocklessAuthorityState, surfaceId: String,
        tombstoneId: String, anchorPaneId: Int64, direction: String,
        expectedTopologyRevision: Int64
    ) throws -> SurfAceLocklessPaneRestoreResult {
        let assigned = nextLabel(state)
        return try SurfAceLocklessTopologyOperations.paneRestore(
            state: &state, surfaceId: surfaceId, tombstoneId: tombstoneId,
            anchorPaneId: anchorPaneId, direction: direction,
            expectedTopologyRevision: expectedTopologyRevision,
            assignedPaneLabel: assigned
        )
    }
}

final class SurfAceLocklessTopologyOperationsTests: XCTestCase {
    func testPaneFinalCloseRemovesRestoreMaterialAndRetainsUnreadScopeWithFencedRelease() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        state.registryBinding = .init(allocatorId: "alloc_test", clientId: allocationTestClientId, fleetId: "fleet-test")
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        try SurfAceLocklessTopologyOperations.applyWindowLabels(
            state: &state, assignments: [(surfaceId: surfaceId, windowLabel: "a")]
        )
        var surface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        surface.allocationGeneration = 30
        var firstPane = try XCTUnwrap(surface.panes["1"])
        firstPane.paneLabel = 1
        firstPane.allocationGeneration = 41
        surface.panes["1"] = firstPane
        state.liveSurfaces[surfaceId] = surface
        let split = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: surfaceId, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        let closedPaneId = try XCTUnwrap(split.newPaneIds.first)
        surface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        var closedPane = try XCTUnwrap(surface.panes[String(closedPaneId)])
        closedPane.allocationGeneration = 42
        surface.panes[String(closedPaneId)] = closedPane
        state.liveSurfaces[surfaceId] = surface
        let encodedSurfaceId = try XCTUnwrap(surfaceId.addingPercentEncoding(withAllowedCharacters: .alphanumerics))
        let paneScopeId = "pane:\(encodedSurfaceId):\(closedPaneId)"
        _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state, scopeId: paneScopeId, scopeKind: "pane", recordId: "record:unread-final-close",
            recordClass: .annotationFrame, payload: .object(["frameId": .string("frame-unread")])
        )
        let unreadScope = try XCTUnwrap(state.scopes[paneScopeId])
        let close = try SurfAceLocklessTopologyOperations.paneFinalClose(
            state: &state, surfaceId: surfaceId, paneId: Int64(closedPaneId),
            expectedTopologyRevision: split.topologyRevision
        )

        XCTAssertEqual(state.liveSurfaces[surfaceId]?.topologyRevision, split.topologyRevision + 1)
        XCTAssertNil(state.liveSurfaces[surfaceId]?.panes[String(closedPaneId)])
        XCTAssertTrue(state.liveSurfaces[surfaceId]?.paneTombstones.isEmpty == true)
        XCTAssertEqual(state.scopes[paneScopeId], unreadScope)
        XCTAssertEqual(state.scopes[paneScopeId]?.records.map(\.recordId), ["record:unread-final-close"])
        XCTAssertEqual(state.terminalCloseRecords?.last?.allocationGeneration, 42)
        XCTAssertEqual(state.terminalCloseRecords?.last?.paneLabel, closedPane.paneLabel)
        let release = try XCTUnwrap(state.allocationReleaseIntents?.first)
        XCTAssertEqual(release.allocationGeneration, 42)
        XCTAssertEqual(release.allocatorId, "alloc_test")
        XCTAssertEqual(release.clientId, allocationTestClientId)
        XCTAssertEqual(release.fleetId, "fleet-test")
        XCTAssertEqual(release.paneId, Int64(closedPaneId))
        XCTAssertEqual(release.paneLineageId, closedPane.paneLineageId)
        XCTAssertEqual(release.paneLabel, closedPane.paneLabel)
        XCTAssertEqual(release.sourceTombstoneId, close.tombstoneId)
        XCTAssertEqual(release.terminalRetirementRevision, close.topologyRevision)
        XCTAssertEqual(release.idempotencyKey, release.releaseId)
        let paneReleaseEvidence = "{\"allocationGeneration\":42,\"clientId\":\"\(allocationTestClientId)\",\"closeRevision\":\(close.topologyRevision),\"lineageId\":\"\(closedPane.paneLineageId)\",\"paneId\":\"\(closedPaneId)\",\"paneLabel\":\(closedPane.paneLabel),\"surfaceId\":\"\(surfaceId)\",\"terminalRetirementRevision\":\(close.topologyRevision),\"tombstoneId\":\"\(close.tombstoneId)\",\"tombstoneKind\":\"pane\"}"
        let expectedReleaseId = SHA256.hash(data: Data(paneReleaseEvidence.utf8))
            .map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(release.releaseId, expectedReleaseId)

        let closedState = state
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.paneRestore(
            state: &state, surfaceId: surfaceId, tombstoneId: close.tombstoneId,
            anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: close.topologyRevision,
            assignedPaneLabel: closedPane.paneLabel
        ))
        XCTAssertEqual(state, closedState)
        try state.validate()
    }

    func testWindowFinalCloseRetiresNestedAllocationsAndKeepsEveryUnreadScope() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        state.registryBinding = .init(allocatorId: "alloc_test", clientId: allocationTestClientId, fleetId: "fleet-test")
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        try SurfAceLocklessTopologyOperations.applyWindowLabels(
            state: &state, assignments: [(surfaceId: surfaceId, windowLabel: "b")]
        )
        var surface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        surface.sceneKeys = ["scene-window-b"]
        surface.allocationGeneration = 30
        var firstPane = try XCTUnwrap(surface.panes["1"])
        firstPane.paneLabel = 1
        firstPane.allocationGeneration = 41
        surface.panes["1"] = firstPane
        state.liveSurfaces[surfaceId] = surface
        state.sceneSurfaceIds["scene-window-b"] = surfaceId
        let split = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: surfaceId, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        let nestedPaneId = try XCTUnwrap(split.newPaneIds.first)
        surface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        var nestedPane = try XCTUnwrap(surface.panes[String(nestedPaneId)])
        nestedPane.allocationGeneration = 42
        surface.panes[String(nestedPaneId)] = nestedPane
        state.liveSurfaces[surfaceId] = surface
        let encodedSurfaceId = try XCTUnwrap(surfaceId.addingPercentEncoding(withAllowedCharacters: .alphanumerics))
        let nestedScopeId = "pane:\(encodedSurfaceId):\(nestedPaneId)"
        _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state, scopeId: nestedScopeId, scopeKind: "pane", recordId: "record:nested-unread",
            recordClass: .annotationFrame, payload: .object(["frameId": .string("nested-frame")])
        )
        let nestedClose = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: Int64(nestedPaneId),
            expectedTopologyRevision: split.topologyRevision, origin: .ambiguous
        )
        let nestedUnreadScope = try XCTUnwrap(state.liveSurfaces[surfaceId]?.paneTombstones.first?.scope)
        let surfaceScopeId = "surface:\(encodedSurfaceId)"
        _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state, scopeId: surfaceScopeId,
            scopeKind: "surface", recordId: "record:surface-unread", recordClass: .content,
            payload: .object(["contentId": .string("kept")])
        )
        let surfaceUnreadScope = try XCTUnwrap(
            state.scopes[surfaceScopeId]
        )
        let close = try SurfAceLocklessTopologyOperations.surfaceWindowFinalClose(
            state: &state, surfaceId: surfaceId, expectedSurfaceSetRevision: 1,
            expectedTopologyRevision: nestedClose.topologyRevision
        )

        XCTAssertTrue(state.liveSurfaces.isEmpty)
        XCTAssertTrue(state.surfaceTombstones.isEmpty)
        XCTAssertNil(state.sceneSurfaceIds["scene-window-b"])
        XCTAssertEqual(state.scopes[surfaceScopeId], surfaceUnreadScope)
        XCTAssertEqual(state.scopes[nestedScopeId], nestedUnreadScope)
        XCTAssertEqual(state.scopes[nestedScopeId]?.records.map(\.recordId), ["record:nested-unread"])
        XCTAssertEqual(state.allocationReleaseIntents?.count, 3)
        XCTAssertEqual(
            Set(state.allocationReleaseIntents?.compactMap(\.allocationGeneration) ?? []),
            Set<Int64>([30, 41, 42])
        )
        XCTAssertTrue(state.allocationReleaseIntents?.allSatisfy { $0.status == .pending } == true)
        XCTAssertTrue(state.allocationReleaseIntents?.contains {
            $0.allocationKind == .pane && $0.sourceTombstoneId == close.tombstoneId
                && $0.sourceTombstoneKind == .surface
        } == true)
        XCTAssertEqual(state.terminalCloseRecords?.count, 3)
        XCTAssertEqual(close.tombstoneId, state.terminalCloseRecords?.first(where: { $0.allocationKind == .surface })?.recordId)
        try state.validate()
    }

    func testStartupFinalizesProvenLegacyPaneCloseButKeepsAnAmbiguousWindowAndItsOtherClaims() async throws {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxAnnotationPublisherStateBytesPerSurface = Int64(SurfAceAnnotationOutbox.maximumBytes)
        limits.maxAnnotationPublisherRecordsPerSurface = Int64(SurfAceAnnotationOutbox.maximumRecords)
        limits.maxRecoverableSurfaceBytes = 704 * 1_024 * 1_024
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        state.registryBinding = .init(allocatorId: "alloc_test", clientId: allocationTestClientId, fleetId: "fleet-test")
        state.annotationPublisher = try SurfAceAnnotationOutbox(
            clientId: allocationTestClientId, sourceEpoch: "0123456789abcdef0123456789abcdef"
        )
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        try SurfAceLocklessTopologyOperations.applyWindowLabels(
            state: &state, assignments: [(surfaceId: surfaceId, windowLabel: "b")]
        )
        var surface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        surface.allocationGeneration = 30
        var firstPane = try XCTUnwrap(surface.panes["1"])
        firstPane.paneLabel = 1
        firstPane.allocationGeneration = 41
        surface.panes["1"] = firstPane
        state.liveSurfaces[surfaceId] = surface
        let split = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: surfaceId, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        let closedPaneId = try XCTUnwrap(split.newPaneIds.first)
        surface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        var closedPane = try XCTUnwrap(surface.panes[String(closedPaneId)])
        closedPane.allocationGeneration = 42
        surface.panes[String(closedPaneId)] = closedPane
        state.liveSurfaces[surfaceId] = surface

        var publisher = try XCTUnwrap(state.annotationPublisher)
        let queuedRecord: [String: Any] = [
            "paneId": closedPaneId, "frameId": "fr_0123456789abcdef0123456789abcdef",
            "kind": "live_delta", "contentId": "content-1", "revision": 1,
            "contentType": "html", "sourceTimestamp": "2026-10-06T23:00:00.000Z",
            "viewport": ["scrollOffset": ["x": 0, "y": 0],
                         "visibleRect": ["x": 0, "y": 0, "width": 100, "height": 100],
                         "contentSize": ["width": 100, "height": 100], "zoomLevel": 1],
            "payload": ["strokes": []],
        ]
        _ = try publisher.append(surfaceId: surfaceId, record: queuedRecord)
        let queuedAnnotation = try XCTUnwrap(publisher.head(surfaceId: surfaceId))
        _ = try publisher.beginFrame(
            surfaceId: surfaceId, paneId: Int(closedPaneId), contextKey: "content-1",
            contentId: "content-1", contentType: "html", revision: 1, url: nil,
            scrollOffset: .init(x: 0, y: 0),
            viewport: .init(width: 100, height: 100, scale: 1), openedAt: 1, image: "aW1hZ2U="
        )
        try publisher.recordStroke(
            surfaceId: surfaceId, paneId: Int(closedPaneId),
            stroke: .init(strokeId: "stroke-upgrade", points: [.init(x: 1, y: 1, pressure: nil)],
                          bbox: .init(x: 1, y: 1, width: 1, height: 1), startedAt: 1, endedAt: 2)
        )
        publisher.setFrameCommitRequested(surfaceId: surfaceId, paneId: Int(closedPaneId), requested: true)
        state.annotationPublisher = publisher

        let encodedSurfaceId = try XCTUnwrap(surfaceId.addingPercentEncoding(withAllowedCharacters: .alphanumerics))
        let paneScopeId = "pane:\(encodedSurfaceId):\(closedPaneId)"
        _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state, scopeId: paneScopeId, scopeKind: "pane", recordId: "record:legacy-pane-unread",
            recordClass: .annotationFrame, payload: .object(["frameId": .string("legacy-unread-frame")])
        )
        let unreadPaneScope = try XCTUnwrap(state.scopes[paneScopeId])
        let paneClose = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: Int64(closedPaneId),
            expectedTopologyRevision: split.topologyRevision
        )
        state.liveSurfaces[surfaceId]?.paneTombstones[0].origin = nil
        let surfaceScopeId = "surface:\(encodedSurfaceId)"
        _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state, scopeId: surfaceScopeId, scopeKind: "surface",
            recordId: "record:legacy-pane-close", recordClass: .topology,
            payload: .object([
                "closedSequence": .integer(paneClose.closedSequence),
                "operation": .string("pane.close"),
                "paneId": .integer(Int64(closedPaneId)),
                "recoverable": .bool(true),
                "tombstoneId": .string(paneClose.tombstoneId),
                "topologyRevision": .integer(paneClose.topologyRevision),
            ])
        )
        let windowClose = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: surfaceId, expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: paneClose.topologyRevision
        )
        state.surfaceTombstones[0].origin = nil
        XCTAssertEqual(state.surfaceTombstones[0].tombstoneId, windowClose.tombstoneId)

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceUpgradeTombstoneMigration-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let migrated = await adapter.snapshot()

        XCTAssertTrue(migrated.liveSurfaces.isEmpty)
        XCTAssertEqual(migrated.surfaceTombstones.count, 1)
        let retainedWindow = try XCTUnwrap(migrated.surfaceTombstones.first)
        XCTAssertEqual(retainedWindow.origin, .ambiguous)
        XCTAssertEqual(retainedWindow.surface.allocationGeneration, 30)
        XCTAssertEqual(retainedWindow.surface.paneTombstones.count, 0)
        XCTAssertNil(retainedWindow.scopes[paneScopeId])
        XCTAssertEqual(migrated.scopes[paneScopeId], unreadPaneScope)
        XCTAssertEqual(migrated.scopes[paneScopeId]?.records.map(\.recordId), ["record:legacy-pane-unread"])
        XCTAssertEqual(migrated.allocationReleaseIntents?.count, 1)
        let paneRelease = try XCTUnwrap(migrated.allocationReleaseIntents?.first)
        XCTAssertEqual(paneRelease.allocationKind, .pane)
        XCTAssertEqual(paneRelease.allocationGeneration, 42)
        XCTAssertEqual(paneRelease.sourceTombstoneId, paneClose.tombstoneId)
        XCTAssertEqual(paneRelease.status, .pending)
        var migratedPublisher = migrated.annotationPublisher
        XCTAssertEqual(try migratedPublisher?.head(surfaceId: surfaceId), queuedAnnotation)
        XCTAssertNil(migratedPublisher?.openFrame(surfaceId: surfaceId, paneId: Int(closedPaneId)))
        XCTAssertFalse(migratedPublisher?.surfaces[surfaceId]?.fifo.contains(where: { entry in
            guard let data = entry.canonical.data(using: .utf8),
                  let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
            return value["kind"] as? String == "frame_commit"
        }) ?? true)

        var restored = migrated
        let restore = try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &restored, tombstoneId: windowClose.tombstoneId,
            expectedSurfaceSetRevision: migrated.surfaceSetRevision
        )
        XCTAssertEqual(restore.surface.surfaceId, surfaceId)
        XCTAssertEqual(restore.surface.allocationGeneration, 30)
        XCTAssertNil(restore.surface.panes[String(closedPaneId)])
        XCTAssertEqual(restore.surface.panes["1"]?.allocationGeneration, 41)
        try restored.validate()

        let restarted = try SurfAceLocklessRuntimeAdapter(store: store)
        let afterRestart = await restarted.snapshot()
        XCTAssertEqual(afterRestart, migrated)
    }

    func testStartupKeepsLegacyPaneTombstoneRestorableWhenCloseEvidenceIsMissing() async throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        state.registryBinding = .init(allocatorId: "alloc_test", clientId: allocationTestClientId, fleetId: "fleet-test")
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        try SurfAceLocklessTopologyOperations.applyWindowLabels(
            state: &state, assignments: [(surfaceId: surfaceId, windowLabel: "c")]
        )
        var surface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        surface.allocationGeneration = 30
        var originalPane = try XCTUnwrap(surface.panes["1"])
        originalPane.paneLabel = 1
        originalPane.allocationGeneration = 41
        surface.panes["1"] = originalPane
        state.liveSurfaces[surfaceId] = surface
        let split = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: surfaceId, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        let closedPaneId = try XCTUnwrap(split.newPaneIds.first)
        surface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        var closedPane = try XCTUnwrap(surface.panes[String(closedPaneId)])
        closedPane.allocationGeneration = 42
        surface.panes[String(closedPaneId)] = closedPane
        state.liveSurfaces[surfaceId] = surface
        let close = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: Int64(closedPaneId),
            expectedTopologyRevision: split.topologyRevision
        )
        state.liveSurfaces[surfaceId]?.paneTombstones[0].origin = nil

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceAmbiguousPaneMigration-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let migrated = await adapter.snapshot()

        let retainedSurface = try XCTUnwrap(migrated.liveSurfaces[surfaceId])
        let retainedPane = try XCTUnwrap(retainedSurface.paneTombstones.first)
        XCTAssertEqual(retainedPane.tombstoneId, close.tombstoneId)
        XCTAssertEqual(retainedPane.origin, .ambiguous)
        XCTAssertEqual(retainedPane.pane.paneId, Int64(closedPaneId))
        XCTAssertEqual(retainedPane.pane.paneLabel, 2)
        XCTAssertEqual(retainedPane.pane.allocationGeneration, 42)
        XCTAssertTrue(migrated.allocationReleaseIntents?.isEmpty == true)

        var restored = migrated
        let restore = try SurfAceLocklessTopologyOperations.paneRestore(
            state: &restored, surfaceId: surfaceId, tombstoneId: close.tombstoneId,
            anchorPaneId: 1, direction: "horizontal",
            expectedTopologyRevision: retainedSurface.topologyRevision,
            assignedPaneLabel: retainedPane.pane.paneLabel
        )
        XCTAssertEqual(restore.paneId, Int64(closedPaneId))
        XCTAssertEqual(restored.liveSurfaces[surfaceId]?.panes[String(closedPaneId)]?.paneLineageId,
                       retainedPane.pane.paneLineageId)
        XCTAssertEqual(restored.liveSurfaces[surfaceId]?.panes[String(closedPaneId)]?.allocationGeneration, 42)
        try restored.validate()
    }

    func testStartupFinalizesAProvenLegacyWindowCloseWithChildReleasesBeforeWindowRelease() async throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        state.registryBinding = .init(allocatorId: "alloc_test", clientId: allocationTestClientId, fleetId: "fleet-test")
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        try SurfAceLocklessTopologyOperations.applyWindowLabels(
            state: &state, assignments: [(surfaceId: surfaceId, windowLabel: "a")]
        )
        var surface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        surface.allocationGeneration = 30
        var pane = try XCTUnwrap(surface.panes["1"])
        pane.paneLabel = 1
        pane.allocationGeneration = 41
        surface.panes["1"] = pane
        state.liveSurfaces[surfaceId] = surface
        surface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        let closeTopologyRevision = surface.topologyRevision
        let encodedSurfaceId = try XCTUnwrap(surfaceId.addingPercentEncoding(withAllowedCharacters: .alphanumerics))
        let surfaceScopeId = "surface:\(encodedSurfaceId)"
        _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state, scopeId: surfaceScopeId, scopeKind: "surface",
            recordId: "record:legacy-window-close", recordClass: .topology,
            payload: .object([
                "operation": .string("surface.window.close"),
                "surfaceId": .string(surfaceId),
            ])
        )
        let close = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: surfaceId, expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: surface.topologyRevision
        )
        state.surfaceTombstones[0].origin = nil

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceUpgradeWindowMigration-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let migrated = await adapter.snapshot()

        XCTAssertTrue(migrated.liveSurfaces.isEmpty)
        XCTAssertTrue(migrated.surfaceTombstones.isEmpty)
        XCTAssertEqual(migrated.terminalCloseRecords?.count, 2)
        XCTAssertEqual(migrated.allocationReleaseIntents?.map(\.allocationKind), [.pane, .surface])
        XCTAssertEqual(migrated.allocationReleaseIntents?.map(\.allocationGeneration), [41, 30])
        XCTAssertTrue(migrated.allocationReleaseIntents?.allSatisfy { $0.status == .pending } == true)
        XCTAssertEqual(migrated.terminalCloseRecords?.first?.closeTopologyRevision, closeTopologyRevision)
        XCTAssertEqual(migrated.terminalCloseRecords?.last?.sourceTombstoneId, close.tombstoneId)
        try migrated.validate()
    }

    func testGlobalLabelsValidateWholeSetAndPreservePaneHistory() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let first = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let second = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 1
        ).surface.surfaceId
        let original = state
        for assignments in [
            [(surfaceId: first, windowLabel: "A")],
            [(surfaceId: "sf_missing", windowLabel: "z")],
            [(surfaceId: first, windowLabel: "z"), (surfaceId: second, windowLabel: "z")]
        ] {
            XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.applyWindowLabels(
                state: &state, assignments: assignments
            ))
            XCTAssertEqual(state, original)
        }
        try SurfAceLocklessTopologyOperations.applyWindowLabels(
            state: &state,
            assignments: [(surfaceId: first, windowLabel: "z"), (surfaceId: second, windowLabel: "aa")]
        )
        XCTAssertEqual(state.liveSurfaces[first]?.windowLabel, "z")
        XCTAssertEqual(state.liveSurfaces[second]?.windowLabel, "aa")
        XCTAssertEqual(state.liveSurfaces[first]?.panes, original.liveSurfaces[first]?.panes)
        XCTAssertEqual(state.liveSurfaces[second]?.panes, original.liveSurfaces[second]?.panes)
        let restored = try JSONDecoder().decode(SurfAceLocklessAuthorityState.self,
            from: JSONEncoder().encode(state))
        XCTAssertEqual(restored, state)
    }

    func testSameRevisionCommitsExactlyOneMutationAndReturnsCurrentTreeToLoser() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        )

        let split = try TestRegistryTopology.paneSplit(
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

    func testClosedPanesRemainRestorableBeyondFormerRetentionLimits() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0).surface.surfaceId
        let split = try TestRegistryTopology.paneSplit(state: &state, surfaceId: surfaceId,
            paneId: 1, count: 3, direction: "horizontal", expectedTopologyRevision: 0)
        state.limits.maxRetainedTombstones = 1
        state.limits.maxRetainedTombstoneBytes = 1
        var closes: [SurfAceLocklessPaneCloseResult] = []
        for (index, paneId) in split.newPaneIds.enumerated() {
            closes.append(try SurfAceLocklessTopologyOperations.paneClose(state: &state,
                surfaceId: surfaceId, paneId: paneId, expectedTopologyRevision: Int64(index + 1)))
        }
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.paneTombstones.count, 2)
        XCTAssertTrue(closes.allSatisfy { $0.reclamations.isEmpty })
        state = try JSONDecoder().decode(SurfAceLocklessAuthorityState.self, from: JSONEncoder().encode(state))
        try state.validate()
        let restored = try TestRegistryTopology.paneRestore(state: &state, surfaceId: surfaceId,
            tombstoneId: closes[0].tombstoneId, anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: 3)
        XCTAssertEqual(restored.paneId, split.newPaneIds[0])
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.paneTombstones.first?.tombstoneId, closes[1].tombstoneId)
    }

    func testPaneCloseRestorePreservesIdentityStateAndAllocatesConflictingLabel() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let split = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: surfaceId, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        state.limits.maxRetainedTombstones = 1
        state.limits.maxRetainedTombstoneBytes = 1
        let closedPaneId = try XCTUnwrap(split.newPaneIds.first)
        let original = try XCTUnwrap(state.liveSurfaces[surfaceId]?.panes[String(closedPaneId)])
        let close = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: closedPaneId, expectedTopologyRevision: 1
        )
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.paneTombstones.count, 1)
        XCTAssertTrue(close.reclamations.isEmpty)
        let encoded = try JSONEncoder().encode(state)
        state = try JSONDecoder().decode(SurfAceLocklessAuthorityState.self, from: encoded)
        state.liveSurfaces[surfaceId]?.panes["1"]?.paneLabel = original.paneLabel

        let restored = try TestRegistryTopology.paneRestore(
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

    func testClosingNestedPanesCollapsesBothSplitsWithoutLosingSurvivorSlot() throws {
        func pane(_ id: Int64, weight: Int64) -> SurfAceLocklessJSON {
            .object(["paneId": .integer(id), "type": .string("pane"), "weight": .integer(weight)])
        }
        func split(_ direction: String, _ weight: Int64, _ children: [SurfAceLocklessJSON]) -> SurfAceLocklessJSON {
            .object(["children": .array(children), "direction": .string(direction),
                     "type": .string("split"), "weight": .integer(weight)])
        }

        var state = try SurfAceLocklessAuthorityState.empty()
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let created = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: surfaceId, paneId: 1, count: 4,
            direction: "horizontal", expectedTopologyRevision: 0
        ).newPaneIds
        let survivor = created[0]
        let firstClosed = created[1]
        let secondClosed = created[2]
        state.liveSurfaces[surfaceId]?.panes[String(survivor)]?.name = "keep this pane"

        let desired: SurfAceLocklessJSON = .object([
            "children": .array([
                pane(1, weight: 3),
                split("vertical", 7, [
                    pane(survivor, weight: 2),
                    split("horizontal", 5, [pane(firstClosed, weight: 1), pane(secondClosed, weight: 1)]),
                ]),
            ]),
            "direction": .string("horizontal"), "type": .string("split"),
        ])
        // Arrange a weighted authoritative tree; topology.apply intentionally
        // builds new nodes without caller-selected weights.
        state.liveSurfaces[surfaceId]?.topology = try SurfAceLocklessTopologyCodec.canonical(desired)
        try state.validate()
        let first = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: firstClosed,
            expectedTopologyRevision: 1
        )
        let afterFirst: SurfAceLocklessJSON = .object([
            "children": .array([
                pane(1, weight: 3),
                split("vertical", 7, [pane(survivor, weight: 2), pane(secondClosed, weight: 5)]),
            ]),
            "direction": .string("horizontal"), "type": .string("split"),
        ])
        XCTAssertEqual(first.topology, afterFirst)

        let second = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: secondClosed,
            expectedTopologyRevision: first.topologyRevision
        )
        let expected: SurfAceLocklessJSON = .object([
            "children": .array([pane(1, weight: 3), pane(survivor, weight: 7)]),
            "direction": .string("horizontal"), "type": .string("split"),
        ])
        XCTAssertEqual(second.topology, expected)
        XCTAssertEqual(try SurfAceLocklessTopologyCodec.paneIds(second.topology), [1, survivor])
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.panes[String(survivor)]?.name, "keep this pane")
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.paneTombstones.count, 2)
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
        let result = try TestRegistryTopology.topologyApply(
            state: &state, surfaceId: surfaceId, targetPaneId: nil, desired: desired,
            allowDestroyPaneIds: [], expectedTopologyRevision: 0
        )
        XCTAssertEqual(result.createdPaneIds.count, 1)
        XCTAssertEqual(result.preservedPaneIds, [1])
        XCTAssertEqual(result.topologyRevision, 1)

        let before = state
        XCTAssertThrowsError(try TestRegistryTopology.topologyApply(
            state: &state, surfaceId: surfaceId, targetPaneId: nil,
            desired: .object(["paneId": .integer(1), "type": .string("pane")]),
            allowDestroyPaneIds: [], expectedTopologyRevision: 1
        )) { error in
            XCTAssertEqual(error as? SurfAceLocklessTopologyOperationError, .invalidTopology("destroy_not_allowed"))
        }
        XCTAssertEqual(state, before)
    }

    func testPaneSplitTopologyApplyAndRestoreRemainUnnumberedUntilRegistryRecovery() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let splitLineage = "pl_unavailable_split"

        let split = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: surfaceId, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0,
            assignedPaneLabels: [:], assignedPaneLineages: [2: splitLineage]
        )
        let splitPaneId = try XCTUnwrap(split.newPaneIds.first)
        XCTAssertEqual(split.newPaneLabels, [0])
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.panes[String(splitPaneId)]?.paneLabel, 0)
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.panes[String(splitPaneId)]?.paneLineageId, splitLineage)

        let closed = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: splitPaneId,
            expectedTopologyRevision: split.topologyRevision
        )
        let restored = try SurfAceLocklessTopologyOperations.paneRestore(
            state: &state, surfaceId: surfaceId, tombstoneId: closed.tombstoneId,
            anchorPaneId: 1, direction: "vertical",
            expectedTopologyRevision: closed.topologyRevision,
            assignedPaneLabel: 0
        )
        XCTAssertEqual(restored.paneLabel, 0)
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.panes[String(splitPaneId)]?.paneLineageId, splitLineage)

        let topologyLineage = "pl_unavailable_topology"
        let applied = try SurfAceLocklessTopologyOperations.topologyApply(
            state: &state, surfaceId: surfaceId, targetPaneId: nil,
            desired: .object([
                "children": .array([
                    .object(["paneId": .integer(1), "type": .string("pane")]),
                    .object(["paneId": .integer(splitPaneId), "type": .string("pane")]),
                    .object(["type": .string("pane")]),
                ]),
                "direction": .string("horizontal"), "type": .string("split"),
            ]),
            allowDestroyPaneIds: [], expectedTopologyRevision: restored.topologyRevision,
            assignedPaneLabels: [:], assignedPaneLineages: [3: topologyLineage]
        )
        let topologyPaneId = try XCTUnwrap(applied.createdPaneIds.first)
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.panes[String(topologyPaneId)]?.paneLabel, 0)
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.panes[String(topologyPaneId)]?.paneLineageId, topologyLineage)
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.nextPaneLabel, 1)
    }

    func testSharedTombstonePoolRetainsClosedPanesBeyondFormerCountLimit() throws {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxRetainedTombstones = 1
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let split = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: surfaceId, paneId: 1, count: 3,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        for paneId in split.newPaneIds {
            state.liveSurfaces[surfaceId]?.panes[String(paneId)]?.history.visible.content = .string("retained source \(paneId)")
            state.liveSurfaces[surfaceId]?.panes[String(paneId)]?.history.visible.annotations = .object(["keep": .bool(true)])
        }
        let original = try XCTUnwrap(state.liveSurfaces[surfaceId])
        let originalScopes = state.scopes
        let first = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: split.newPaneIds[0], expectedTopologyRevision: 1
        )
        let second = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: split.newPaneIds[1], expectedTopologyRevision: 2
        )
        XCTAssertTrue(first.reclamations.isEmpty)
        XCTAssertTrue(second.reclamations.isEmpty)
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.paneTombstones.map(\.tombstoneId),
                       [first.tombstoneId, second.tombstoneId])
        XCTAssertLessThan(first.closedSequence, second.closedSequence)
        for closed in [first, second] {
            let restored = try SurfAceLocklessTopologyOperations.paneRestore(
                state: &state, surfaceId: surfaceId, tombstoneId: closed.tombstoneId,
                anchorPaneId: 1, direction: "horizontal",
                expectedTopologyRevision: try XCTUnwrap(state.liveSurfaces[surfaceId]?.topologyRevision),
                assignedPaneLabel: try XCTUnwrap(original.panes[String(closed.paneId)]?.paneLabel)
            )
            XCTAssertEqual(state.liveSurfaces[surfaceId]?.panes[String(restored.paneId)],
                           original.panes[String(restored.paneId)])
        }
        XCTAssertEqual(state.scopes, originalScopes)
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.paneTombstones, [])
    }

    func testSurfaceCloseRestorePreservesStableIdsAndAllNestedMaterial() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0, placement: .object(["display": .string("main")])
        )
        let surfaceId = opened.surface.surfaceId
        _ = try TestRegistryTopology.paneSplit(
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
        _ = try TestRegistryTopology.paneSplit(
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
        _ = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: "sf_1", paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 2
        )
        _ = try TestRegistryTopology.paneRestore(
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
        XCTAssertThrowsError(try TestRegistryTopology.paneSplit(
            state: &restoredState, surfaceId: "sf_1", paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 4
        )) { error in
            XCTAssertEqual(error as? SurfAceLocklessTopologyOperationError,
                           .paneCapacity(current: 3, requested: 4, maximum: 2))
        }
    }

    func testContentAndAnnotationsRemainRecoverableBeyondFormerByteCaps() throws {
        var state = try populatedPaneCloseFixture()
        let surfaceId = "sf_1"
        state.limits.maxPaneRecoverableStateBytes = 1
        state.limits.maxPaneAnnotationRestoreBytes = 1
        state.limits.maxSurfaceRecoverableBaseBytes = 1
        state.limits.maxRecoverableSurfaceBytes = 1
        state.limits.maxRetainedTombstoneBytes = 1
        let original = state
        let closed = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: surfaceId, paneId: 2, expectedTopologyRevision: 1
        )
        _ = try TestRegistryTopology.paneRestore(
            state: &state, surfaceId: surfaceId, tombstoneId: closed.tombstoneId,
            anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: 2
        )
        let restoredPane = try XCTUnwrap(state.liveSurfaces[surfaceId]?.panes["2"])
        let originalPane = try XCTUnwrap(original.liveSurfaces[surfaceId]?.panes["2"])
        XCTAssertEqual(restoredPane.paneId, originalPane.paneId)
        XCTAssertEqual(restoredPane.paneLineageId, originalPane.paneLineageId)
        XCTAssertGreaterThan(restoredPane.paneLabel, originalPane.paneLabel)
        var originalWithFreshRegistryLabel = originalPane
        originalWithFreshRegistryLabel.paneLabel = restoredPane.paneLabel
        XCTAssertEqual(restoredPane, originalWithFreshRegistryLabel)

        let beforeWindowClose = try XCTUnwrap(state.liveSurfaces[surfaceId])
        let windowClose = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: surfaceId, expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: beforeWindowClose.topologyRevision)
        XCTAssertTrue(windowClose.reclamations.isEmpty)
        state = try JSONDecoder().decode(SurfAceLocklessAuthorityState.self, from: JSONEncoder().encode(state))
        try state.validate()
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &state, tombstoneId: windowClose.tombstoneId,
            expectedSurfaceSetRevision: state.surfaceSetRevision)
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.panes["2"], originalWithFreshRegistryLabel)
        XCTAssertEqual(state.liveSurfaces[surfaceId]?.panes["1"]?.history,
                       beforeWindowClose.panes["1"]?.history)
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
        _ = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: "sf_1", paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 2
        )
        XCTAssertEqual(state.liveSurfaces["sf_1"]?.panes.count, 2)
        let restored = try TestRegistryTopology.paneRestore(
            state: &state, surfaceId: "sf_1", tombstoneId: close.tombstoneId,
            anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: 3
        )
        XCTAssertEqual(restored.paneId, originalPane.paneId)
        XCTAssertEqual(state.liveSurfaces["sf_1"]?.panes["2"]?.history, originalPane.history)
        XCTAssertEqual(state.scopes[originalScope.scopeId], originalScope)
        XCTAssertEqual(state.liveSurfaces["sf_1"]?.panes.count, 3)
        XCTAssertTrue(state.liveSurfaces["sf_1"]?.paneTombstones.isEmpty == true)
    }

    func testACCLOSE06FormerCountAndBytePressurePreservesClosedSequenceAndState() throws {
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
        XCTAssertTrue(first.reclamations.isEmpty)
        XCTAssertTrue(second.reclamations.isEmpty)
        XCTAssertEqual(countState.surfaceTombstones.map(\.tombstoneId), [first.tombstoneId, second.tombstoneId])
        XCTAssertEqual(countState.surfaceTombstones.map(\.closedSequence), [first.closedSequence, second.closedSequence])

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
        XCTAssertTrue(closed.allSatisfy { $0.reclamations.isEmpty })
        XCTAssertEqual(byteState.surfaceTombstones.map(\.tombstoneId), closed.map(\.tombstoneId))
        XCTAssertEqual(byteState.surfaceTombstones.map(\.closedSequence), closed.map(\.closedSequence))
        XCTAssertGreaterThan(Int64(try JSONEncoder().encode(byteState.surfaceTombstones).count),
                             byteState.limits.maxRetainedTombstoneBytes)
        for retained in byteState.surfaceTombstones {
            XCTAssertEqual(retained.surface.nativeRestoreMaterial,
                           .object(["placement": .string(String(repeating: "a", count: 45_000))]))
        }
        let restarted = try JSONDecoder().decode(SurfAceLocklessAuthorityState.self,
                                                 from: JSONEncoder().encode(byteState))
        try restarted.validate()
        XCTAssertEqual(restarted, byteState)
    }

    func testACCLOSE08ReadsAndFailedRestorePreserveRetainedLifecycleOrder() throws {
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
        XCTAssertEqual(state.surfaceTombstones.first, observed)
        let before = state
        XCTAssertThrowsError(try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &state, tombstoneId: first.tombstoneId,
            expectedSurfaceSetRevision: state.surfaceSetRevision - 1
        )) { error in
            XCTAssertEqual(error as? SurfAceLocklessTopologyOperationError,
                           .staleSurfaceSet(currentRevision: before.surfaceSetRevision))
        }
        XCTAssertEqual(state, before)
        let restored = try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &state, tombstoneId: first.tombstoneId,
            expectedSurfaceSetRevision: state.surfaceSetRevision)
        XCTAssertEqual(restored.surface, observed?.surface)
        XCTAssertEqual(state.surfaceTombstones, Array(before.surfaceTombstones.dropFirst()))
        XCTAssertEqual(state.sequences.nextClosedSequence, before.sequences.nextClosedSequence)
    }

    func testACCLOSE09RetainedIdentitiesDoNotEmitQuotaReclamationDiagnostics() throws {
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
        XCTAssertTrue(close.reclamations.isEmpty)
        XCTAssertTrue((state.pendingTombstoneReclamations ?? []).isEmpty)
        let retained = try XCTUnwrap(state.surfaceTombstones.first)
        XCTAssertEqual(retained.tombstoneId, first.tombstoneId)
        XCTAssertEqual(retained.surface.surfaceId, firstId)
        XCTAssertEqual(retained.closedSequence, first.closedSequence)
        XCTAssertEqual(retained.surface.panes.count, 1)
        XCTAssertEqual(state.surfaceTombstones.map(\.surface.surfaceId), [firstId, secondId])
        let beforeRestore = state
        let restored = try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &state, tombstoneId: first.tombstoneId,
            expectedSurfaceSetRevision: state.surfaceSetRevision)
        XCTAssertEqual(restored.surface, retained.surface)
        XCTAssertEqual(state.surfaceTombstones, Array(beforeRestore.surfaceTombstones.dropFirst()))
        XCTAssertTrue((state.pendingTombstoneReclamations ?? []).isEmpty)
    }

    func testACCAP01CreationCapRetainedConservationAndCapacityFreeRestore() throws {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxPanesPerSurface = 3
        limits.maxRetainedTombstones = 2
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        let id = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let filled = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 3,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        XCTAssertEqual(state.liveSurfaces[id]?.panes.count, 3)
        let beforeRefusal = state
        XCTAssertThrowsError(try TestRegistryTopology.paneSplit(
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
        _ = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 3,
            direction: "vertical", expectedTopologyRevision: 3
        )
        XCTAssertEqual((state.liveSurfaces[id]?.panes.count ?? 0) + (state.liveSurfaces[id]?.paneTombstones.count ?? 0), 5)
        _ = try TestRegistryTopology.paneRestore(
            state: &state, surfaceId: id, tombstoneId: first.tombstoneId,
            anchorPaneId: 1, direction: "horizontal", expectedTopologyRevision: 4
        )
        _ = try TestRegistryTopology.paneRestore(
            state: &state, surfaceId: id, tombstoneId: second.tombstoneId,
            anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: 5
        )
        XCTAssertEqual(state.liveSurfaces[id]?.panes.count, 5)
        XCTAssertEqual(state.liveSurfaces[id]?.paneTombstones.count, 0)
        XCTAssertThrowsError(try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 6
        ))
    }

    func testACCLOSE03StaleAndInvalidPlacementPreserveTombstoneUntilFreshRetry() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let id = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        let split = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        let close = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: id, paneId: split.newPaneIds[0], expectedTopologyRevision: 1
        )
        let retained = state.liveSurfaces[id]?.paneTombstones
        XCTAssertThrowsError(try TestRegistryTopology.paneRestore(
            state: &state, surfaceId: id, tombstoneId: close.tombstoneId,
            anchorPaneId: 1, direction: "vertical", expectedTopologyRevision: 1
        ))
        XCTAssertEqual(state.liveSurfaces[id]?.paneTombstones, retained)
        XCTAssertThrowsError(try TestRegistryTopology.paneRestore(
            state: &state, surfaceId: id, tombstoneId: close.tombstoneId,
            anchorPaneId: 999, direction: "diagonal", expectedTopologyRevision: 2
        ))
        XCTAssertEqual(state.liveSurfaces[id]?.paneTombstones, retained)
        XCTAssertEqual(try TestRegistryTopology.paneRestore(
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
        _ = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        let before = state
        XCTAssertThrowsError(try TestRegistryTopology.paneSplit(
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
        let split = try TestRegistryTopology.paneSplit(
            state: &state, surfaceId: id, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: 0
        )
        let second = try XCTUnwrap(split.newPaneIds.first)
        XCTAssertEqual(state.liveSurfaces[id]?.panes["1"]?.paneId, 1)
        let renamed = try SurfAceLocklessTopologyOperations.paneRename(
            state: &state, surfaceId: id, paneId: second, name: "two", expectedTopologyRevision: 1
        )
        XCTAssertEqual(renamed.topologyRevision, 2)
        let applied = try TestRegistryTopology.topologyApply(
            state: &state, surfaceId: id, targetPaneId: nil,
            desired: split.topology, allowDestroyPaneIds: [], expectedTopologyRevision: 2
        )
        XCTAssertEqual(applied.preservedPaneIds.sorted(), [1, second])
        let closed = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: id, paneId: second, expectedTopologyRevision: 3
        )
        let restored = try TestRegistryTopology.paneRestore(
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
                result.append(try TestRegistryTopology.paneSplit(
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
