import Foundation
import XCTest
@testable import SurfAce

final class SurfAceAnnotationOutboxTests: XCTestCase {
    private let sourceEpoch = "0123456789abcdef0123456789abcdef"
    private let surfaceId = "sf_1"

    private func record(padding: Int = 0) -> [String: Any] {
        [
            "paneId": 1, "frameId": "fr_0123456789abcdef0123456789abcdef",
            "kind": "live_delta", "contentId": "content-1", "revision": 1,
            "contentType": "html", "sourceTimestamp": "2026-10-06T23:00:00.000Z",
            "viewport": ["scrollOffset": ["x": 0, "y": 0], "visibleRect": ["x": 0, "y": 0, "width": 100, "height": 100],
                         "contentSize": ["width": 100, "height": 100], "zoomLevel": 1],
            "payload": ["strokes": [], "padding": String(repeating: "x", count: padding)],
        ]
    }

    func testBoundedOutboxKeepsAcceptedPrefixAndSealsContiguousOverflow() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        XCTAssertEqual(try outbox.append(surfaceId: surfaceId, record: record(), maxBytes: 18_500), "1")
        let first = try XCTUnwrap(outbox.head(surfaceId: surfaceId, maxBytes: 18_500))
        XCTAssertEqual(first.kind, "payload")
        XCTAssertEqual(first.sourceSequence, "1")
        XCTAssertEqual(try outbox.append(surfaceId: surfaceId, record: record(padding: 4_000), maxBytes: 18_500), "2")
        XCTAssertEqual(try outbox.append(surfaceId: surfaceId, record: record(), maxBytes: 18_500), "3")
        XCTAssertEqual(outbox.surfaces[surfaceId]?.fifo.first, first)
        XCTAssertEqual(outbox.surfaces[surfaceId]?.trailingGap?.from, "2")
        XCTAssertEqual(outbox.surfaces[surfaceId]?.trailingGap?.through, "3")
        try outbox.accept(surfaceId: surfaceId, head: first,
                          cursor: .init(epoch: sourceEpoch, sequence: "1"))
        let gap = try XCTUnwrap(outbox.head(surfaceId: surfaceId, maxBytes: 18_500))
        XCTAssertEqual(gap.kind, "gap")
        let serialized = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(gap.canonical.utf8)) as? [String: Any])
        XCTAssertEqual(serialized["lostFromSequence"] as? String, "2")
        XCTAssertEqual(serialized["lostThroughSequence"] as? String, "3")
        XCTAssertEqual(serialized["sourceSequence"] as? String, "3")
        try outbox.validate(maxBytes: 18_500)
        let restored = try JSONDecoder().decode(SurfAceAnnotationOutbox.self, from: JSONEncoder().encode(outbox))
        XCTAssertEqual(restored, outbox)
    }

    func testDefiniteRejectionReplacesSameSequenceAndEventId() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        _ = try outbox.append(surfaceId: surfaceId, record: record())
        let before = try XCTUnwrap(outbox.head(surfaceId: surfaceId))
        try outbox.rejectHead(surfaceId: surfaceId, code: "annotation_context_image_invalid")
        let after = try XCTUnwrap(outbox.head(surfaceId: surfaceId))
        XCTAssertEqual(after.kind, "gap")
        XCTAssertEqual(after.sourceSequence, before.sourceSequence)
        XCTAssertEqual(after.sourceEventId, before.sourceEventId)
        XCTAssertEqual(outbox.surfaces[surfaceId]?.diagnostic?.code, "annotation_context_image_invalid")
        XCTAssertThrowsError(try outbox.accept(surfaceId: surfaceId, head: before,
                                               cursor: .init(epoch: sourceEpoch, sequence: "1")))
    }

    func testPublisherReservationMustFitFullRecoverableSurfaceEnvelope() throws {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxAnnotationPublisherStateBytesPerSurface = Int64(SurfAceAnnotationOutbox.maximumBytes)
        limits.maxAnnotationPublisherRecordsPerSurface = Int64(SurfAceAnnotationOutbox.maximumRecords)
        XCTAssertThrowsError(try limits.validate())
        limits.maxRecoverableSurfaceBytes = 704 * 1_024 * 1_024
        try limits.validate()
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        state.annotationPublisher = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        try state.validate()
        let restored = try JSONDecoder().decode(SurfAceLocklessAuthorityState.self,
                                                from: JSONEncoder().encode(state))
        XCTAssertEqual(restored.annotationPublisher, state.annotationPublisher)
    }

    func testSurfaceCloseChargesPublisherPartitionAndRetainsItsSourceHistory() async throws {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxAnnotationPublisherStateBytesPerSurface = Int64(SurfAceAnnotationOutbox.maximumBytes)
        limits.maxAnnotationPublisherRecordsPerSurface = Int64(SurfAceAnnotationOutbox.maximumRecords)
        limits.maxRecoverableSurfaceBytes = 704 * 1_024 * 1_024
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        state.annotationPublisher = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: state.surfaceSetRevision)
        let surfaceId = opened.surface.surfaceId
        _ = try state.annotationPublisher?.append(surfaceId: surfaceId, record: record())
        let pending = try XCTUnwrap(state.annotationPublisher?.head(surfaceId: surfaceId))
        let publisherBytes = try XCTUnwrap(state.annotationPublisher?.partitionBytes(surfaceId: surfaceId))
        let topologyRevision = try XCTUnwrap(state.liveSurfaces[surfaceId]?.topologyRevision)
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: surfaceId,
            expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: topologyRevision)
        let tombstone = try XCTUnwrap(state.surfaceTombstones.first)
        let base = try SurfAceLocklessTopologyOperations.restoredSurfaceTombstoneBytes(
            closedSequence: tombstone.closedSequence, scopes: tombstone.scopes,
            surface: tombstone.surface, tombstoneId: tombstone.tombstoneId)
        XCTAssertEqual(tombstone.bytes, base + publisherBytes)
        XCTAssertEqual(state.annotationPublisher?.surfaces[surfaceId]?.fifo.first, pending)
        try state.validate()

        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceAnnotationClose-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store, annotationClientId: "client-1")
        let epoch = sourceEpoch
        try await adapter.transactAnnotationPublisher(surfaceId: surfaceId) { publisher in
            try publisher.accept(surfaceId: surfaceId, head: pending,
                                 cursor: .init(epoch: epoch, sequence: "1"))
        }
        let accepted = await adapter.snapshot()
        let updatedTombstone = try XCTUnwrap(accepted.surfaceTombstones.first)
        let remainingBytes = try XCTUnwrap(accepted.annotationPublisher?.partitionBytes(surfaceId: surfaceId))
        XCTAssertEqual(updatedTombstone.bytes, base + remainingBytes)
        XCTAssertLessThan(updatedTombstone.bytes, tombstone.bytes)
        try accepted.validate()
    }

    func testConfiguredAdapterMigratesOldStateBeforeAdmissionAndKeepsEpochOnRestart() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceAnnotationMigration-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        try store.save(SurfAceLocklessAuthorityState.empty())
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store, annotationClientId: "client-1")
        let state = await adapter.snapshot()
        XCTAssertEqual(state.annotationPublisher?.clientId, "client-1")
        XCTAssertEqual(state.limits.maxAnnotationPublisherStateBytesPerSurface,
                       Int64(SurfAceAnnotationOutbox.maximumBytes))
        XCTAssertEqual(state.limits.maxRecoverableSurfaceBytes, 704 * 1_024 * 1_024)
        let restarted = try SurfAceLocklessRuntimeAdapter(store: store, annotationClientId: "client-1")
        let afterRestart = await restarted.snapshot()
        XCTAssertEqual(afterRestart.annotationPublisher?.sourceEpoch,
                       state.annotationPublisher?.sourceEpoch)
    }

    func testTombstoneReclamationPreservesUnacceptedSourcePartition() throws {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxRetainedTombstones = 1
        limits.maxAnnotationPublisherStateBytesPerSurface = Int64(SurfAceAnnotationOutbox.maximumBytes)
        limits.maxAnnotationPublisherRecordsPerSurface = Int64(SurfAceAnnotationOutbox.maximumRecords)
        limits.maxRecoverableSurfaceBytes = 704 * 1_024 * 1_024
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        state.annotationPublisher = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        let first = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: state.surfaceSetRevision)
        _ = try state.annotationPublisher?.append(surfaceId: first.surface.surfaceId, record: record())
        let pending = try XCTUnwrap(state.annotationPublisher?.head(surfaceId: first.surface.surfaceId))
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: first.surface.surfaceId,
            expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: first.surface.topologyRevision)
        let second = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: state.surfaceSetRevision)
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: second.surface.surfaceId,
            expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: second.surface.topologyRevision)
        XCTAssertFalse(state.surfaceTombstones.contains { $0.surface.surfaceId == first.surface.surfaceId })
        XCTAssertEqual(state.annotationPublisher?.surfaces[first.surface.surfaceId]?.fifo.first, pending)
        try state.validate()
    }

    func testAtOpenFrameAndStrokePositionSurviveRestartUntilExplicitClose() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        let frame = try outbox.beginFrame(
            surfaceId: surfaceId, paneId: 1, contextKey: "content-1", contentId: "content-1",
            url: nil, scrollOffset: .init(x: 4, y: 8),
            viewport: .init(width: 100, height: 80, scale: 2), openedAt: 1000,
            image: "aW1hZ2U="
        )
        let stroke = SurfAceAnnotationFrameStroke(
            strokeId: "stroke-1", points: [.init(x: 10, y: 20, pressure: 0.5)],
            bbox: .init(x: 10, y: 20, width: 0, height: 0), startedAt: 1000, endedAt: 1010
        )
        try outbox.recordStroke(surfaceId: surfaceId, paneId: 1, stroke: stroke)
        outbox.markFramePublished(surfaceId: surfaceId, paneId: 1)
        outbox.setFrameCommitRequested(surfaceId: surfaceId, paneId: 1, requested: true)
        let restored = try JSONDecoder().decode(SurfAceAnnotationOutbox.self,
                                                from: JSONEncoder().encode(outbox))
        let open = try XCTUnwrap(restored.openFrame(surfaceId: surfaceId, paneId: 1))
        XCTAssertEqual(open.frameId, frame.frameId)
        XCTAssertEqual(open.image, frame.image)
        XCTAssertEqual(open.strokes, [stroke])
        XCTAssertEqual(open.publishedStrokeCount, 1)
        XCTAssertEqual(open.commitRequested, true)
        XCTAssertEqual(try outbox.beginFrame(
            surfaceId: surfaceId, paneId: 1, contextKey: "content-1", contentId: "content-1",
            url: nil, scrollOffset: .init(x: 0, y: 0),
            viewport: .init(width: 1, height: 1, scale: 1), openedAt: 2000, image: "different"
        ).frameId, frame.frameId)
        outbox.closeFrame(surfaceId: surfaceId, paneId: 1)
        XCTAssertNil(outbox.openFrame(surfaceId: surfaceId, paneId: 1))
    }
}

@MainActor
private final class AnnotationWireProbe {
    var records: [String] = []
    var connections = 0
}

@MainActor
private final class AnnotationWireProbeTransport: SurfAceAnnotationWireTransport {
    let probe: AnnotationWireProbe
    init(_ probe: AnnotationWireProbe) {
        self.probe = probe
        probe.connections += 1
    }

    func exchange(_ data: Data) async throws -> Data {
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let op = try XCTUnwrap(request["op"] as? String)
        let id = try XCTUnwrap(request["id"] as? String)
        var reply: [String: Any] = ["v": 1, "type": "response", "op": op, "id": id, "ok": true]
        if op != "annotation.hello" {
            let payload = try XCTUnwrap(request["payload"] as? [String: Any])
            let record = try XCTUnwrap(payload["record"] as? [String: Any])
            let canonical = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys])
            probe.records.append(String(decoding: canonical, as: UTF8.self))
            if probe.records.count == 1 { throw URLError(.networkConnectionLost) }
            reply["payload"] = [
                "serverCursor": ["epoch": "0123456789abcdef0123456789abcdef", "sequence": "1"],
                "duplicate": true, "committedAt": "2026-10-06T23:00:00.000Z",
            ]
        } else {
            reply["payload"] = ["registryId": "registry-1"]
        }
        return try JSONSerialization.data(withJSONObject: reply)
    }

    func close() {}
}

extension SurfAceAnnotationOutboxTests {
    @MainActor
    func testPublisherResendsPersistedHeadAfterAmbiguousDisconnect() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceAnnotationTransport-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxAnnotationPublisherStateBytesPerSurface = Int64(SurfAceAnnotationOutbox.maximumBytes)
        limits.maxAnnotationPublisherRecordsPerSurface = Int64(SurfAceAnnotationOutbox.maximumRecords)
        limits.maxRecoverableSurfaceBytes = 704 * 1_024 * 1_024
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        state.annotationPublisher = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: state.surfaceSetRevision)
        let surfaceId = opened.surface.surfaceId
        _ = try state.annotationPublisher?.append(surfaceId: surfaceId, record: record())
        let expected = try XCTUnwrap(state.annotationPublisher?.head(surfaceId: surfaceId))
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store, annotationClientId: "client-1")
        let probe = AnnotationWireProbe()
        let publisher = try SurfAceAnnotationPublisher(
            adapter: adapter, endpoint: XCTUnwrap(URL(string: "ws://127.0.0.1:19001")),
            makeTransport: { _ in AnnotationWireProbeTransport(probe) }, onError: { _ in }
        )
        publisher.notify()
        for _ in 0..<80 {
            if (await adapter.snapshot()).annotationPublisher?.surfaces[surfaceId]?.acceptedCursor != nil { break }
            try await Task.sleep(for: .milliseconds(50))
        }
        publisher.stop()
        XCTAssertGreaterThanOrEqual(probe.connections, 2)
        XCTAssertEqual(probe.records, [expected.canonical, expected.canonical])
        let saved = try XCTUnwrap(store.load())
        XCTAssertEqual(saved.annotationPublisher?.surfaces[surfaceId]?.acceptedCursor?.sequence, "1")
        XCTAssertEqual(saved.annotationPublisher?.pendingSurfaceIds(), [])
    }
}
