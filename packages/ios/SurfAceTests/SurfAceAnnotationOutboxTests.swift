import Foundation
import XCTest
@testable import SurfAce

final class SurfAceAnnotationOutboxTests: XCTestCase {
    func testSharedSchemeDeliversAppHostIsolationFlag() {
        XCTAssertEqual(ProcessInfo.processInfo.environment["SURF_ACE_XCTEST_HOST_NO_AUTOSTART"], "1")
    }

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

    func testCanonicalSourceBytesUseECMAScriptNumbersEscapesAndUTF16KeyOrder() throws {
        let canonical = try XCTUnwrap(SurfAceAnnotationOutbox.canonical([
            "\u{E000}": 1.0,
            "😀": -0.0,
            "slash": "/\n\t\u{0000}",
            "small": 0.000001,
            "tiny": 0.0000001,
            "large": 1e21,
        ]))
        XCTAssertEqual(canonical,
                       "{\"large\":1e+21,\"slash\":\"/\\n\\t\\u0000\",\"small\":0.000001,\"tiny\":1e-7,\"😀\":0,\"\u{E000}\":1}")
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

    func testGapConsumesItsReservedSlotAtExactByteBoundary() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        _ = try outbox.append(surfaceId: surfaceId, record: record())
        let maxBytes = max(Int(try outbox.partitionBytes(surfaceId: surfaceId)) + 1,
                           1_024) + 2 * SurfAceAnnotationOutbox.gapSlotBytes
        let payload = try XCTUnwrap(outbox.head(surfaceId: surfaceId, maxBytes: maxBytes))
        XCTAssertEqual(try outbox.append(surfaceId: surfaceId, record: record(padding: 4_000),
                                         maxBytes: maxBytes), "2")
        XCTAssertEqual(outbox.surfaces[surfaceId]?.trailingGap?.through, "2")
        try outbox.validate(maxBytes: maxBytes)
        try outbox.accept(surfaceId: surfaceId, head: payload,
                          cursor: .init(epoch: sourceEpoch, sequence: "1"))
        let gap = try XCTUnwrap(outbox.head(surfaceId: surfaceId, maxBytes: maxBytes))
        XCTAssertEqual(gap.kind, "gap")
        XCTAssertEqual(gap.sourceSequence, "2")
        try outbox.validate(maxBytes: maxBytes)
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

    func testFailedSourceFrameRetainsDirectRecoveryStrokeIds() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        _ = try outbox.beginFrame(
            surfaceId: surfaceId, paneId: 1, contextKey: "content-1",
            contentId: "content-1", contentType: "html", revision: 1, url: nil,
            scrollOffset: .init(x: 0, y: 0),
            viewport: .init(width: 2, height: 2, scale: 1), openedAt: 1, image: ""
        )
        let stroke = SurfAceAnnotationFrameStroke(
            strokeId: "stroke-1", points: [.init(x: 1, y: 1, pressure: nil)],
            bbox: .init(x: 1, y: 1, width: 0, height: 0), startedAt: 1, endedAt: 2
        )
        try outbox.recordStroke(surfaceId: surfaceId, paneId: 1, stroke: stroke,
                                sourceViewport: "{\"zoomLevel\":1}")
        let restored = try JSONDecoder().decode(SurfAceAnnotationOutbox.self,
                                                from: JSONEncoder().encode(outbox))
        let frame = try XCTUnwrap(restored.openFrame(surfaceId: surfaceId, paneId: 1))
        XCTAssertTrue(frame.failed)
        XCTAssertTrue(frame.strokes.isEmpty)
        XCTAssertEqual(frame.directStrokeIds, ["stroke-1"])
        XCTAssertEqual(frame.lastSourceViewport, "{\"zoomLevel\":1}")
        try outbox.validate()
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

    func testDirectBoundaryEvidenceSurvivesEachCrashPoint() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        _ = try outbox.beginFrame(
            surfaceId: surfaceId, paneId: 1, contextKey: "content-1", contentId: "content-1",
            url: nil, scrollOffset: .init(x: 0, y: 0),
            viewport: .init(width: 2, height: 2, scale: 1), openedAt: 1,
            image: "aW1hZ2U="
        )
        try outbox.recordStroke(surfaceId: surfaceId, paneId: 1, stroke: .init(
            strokeId: "stroke-1", points: [.init(x: 1, y: 1, pressure: nil)],
            bbox: .init(x: 1, y: 1, width: 0, height: 0), startedAt: 1, endedAt: 2
        ))
        outbox.setFrameCommitRequested(surfaceId: surfaceId, paneId: 1, requested: true)
        let flush = SurfAceAnnotationDirectEvent(
            eventId: "ev_flush", payload: "{\"strokeId\":\"stroke-1\"}",
            sentAt: 3, throughStrokeCount: 1
        )
        try outbox.stageDirectFlush(surfaceId: surfaceId, paneId: 1, event: flush)
        var restored = try JSONDecoder().decode(SurfAceAnnotationOutbox.self,
                                                 from: JSONEncoder().encode(outbox))
        XCTAssertEqual(restored.openFrame(surfaceId: surfaceId, paneId: 1)?.pendingDirectFlush, flush)
        XCTAssertEqual(restored.openFrame(surfaceId: surfaceId, paneId: 1)?.directCommitDelivered, nil)
        try restored.markDirectFlushDelivered(surfaceId: surfaceId, paneId: 1,
                                              eventId: flush.eventId)
        restored = try JSONDecoder().decode(SurfAceAnnotationOutbox.self,
                                             from: JSONEncoder().encode(restored))
        XCTAssertNil(restored.openFrame(surfaceId: surfaceId, paneId: 1)?.pendingDirectFlush)
        XCTAssertEqual(restored.openFrame(surfaceId: surfaceId, paneId: 1)?.deliveredDirectStrokeCount, 1)
        let commit = SurfAceAnnotationDirectEvent(
            eventId: "ev_commit", payload: "{\"contentId\":\"content-1\"}",
            sentAt: 4, throughStrokeCount: 1
        )
        try restored.stageDirectCommit(surfaceId: surfaceId, paneId: 1, event: commit)
        restored = try JSONDecoder().decode(SurfAceAnnotationOutbox.self,
                                             from: JSONEncoder().encode(restored))
        XCTAssertEqual(restored.openFrame(surfaceId: surfaceId, paneId: 1)?.pendingDirectCommit, commit)
        try restored.markDirectCommitDelivered(surfaceId: surfaceId, paneId: 1,
                                               eventId: commit.eventId)
        restored = try JSONDecoder().decode(SurfAceAnnotationOutbox.self,
                                             from: JSONEncoder().encode(restored))
        XCTAssertNil(restored.openFrame(surfaceId: surfaceId, paneId: 1)?.pendingDirectCommit)
        XCTAssertEqual(restored.openFrame(surfaceId: surfaceId, paneId: 1)?.directCommitDelivered, true)
    }

    func testProvenDirectCommitCannotReuseFrameWhileSourceFinalizationRetries() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        let first = try outbox.beginFrame(
            surfaceId: surfaceId, paneId: 1, contextKey: "content-1", contentId: "content-1",
            url: nil, scrollOffset: .init(x: 0, y: 0),
            viewport: .init(width: 2, height: 2, scale: 1), openedAt: 1, image: "aW1hZ2U="
        )
        outbox.setFrameCommitRequested(surfaceId: surfaceId, paneId: 1, requested: true)
        let commit = SurfAceAnnotationDirectEvent(
            eventId: "ev_commit", payload: "{}", sentAt: 2, throughStrokeCount: 0
        )
        try outbox.stageDirectCommit(surfaceId: surfaceId, paneId: 1, event: commit)
        try outbox.markDirectCommitDelivered(surfaceId: surfaceId, paneId: 1,
                                             eventId: commit.eventId)
        let durable = try JSONDecoder().decode(SurfAceAnnotationOutbox.self,
                                                from: JSONEncoder().encode(outbox))
        var recovered = durable
        XCTAssertThrowsError(try recovered.beginFrame(
            surfaceId: surfaceId, paneId: 1, contextKey: "content-1", contentId: "content-1",
            url: nil, scrollOffset: .init(x: 0, y: 0),
            viewport: .init(width: 2, height: 2, scale: 1), openedAt: 3, image: "bmV3"
        ))
        XCTAssertThrowsError(try recovered.recordStroke(
            surfaceId: surfaceId, paneId: 1,
            stroke: .init(strokeId: "later-stroke", points: [.init(x: 1, y: 1, pressure: nil)],
                          bbox: .init(x: 1, y: 1, width: 0, height: 0), startedAt: 3, endedAt: 4)
        ))
        XCTAssertEqual(recovered.openFrame(surfaceId: surfaceId, paneId: 1),
                       durable.openFrame(surfaceId: surfaceId, paneId: 1))
        recovered.closeFrame(surfaceId: surfaceId, paneId: 1)
        let next = try recovered.beginFrame(
            surfaceId: surfaceId, paneId: 1, contextKey: "content-1", contentId: "content-1",
            url: nil, scrollOffset: .init(x: 0, y: 0),
            viewport: .init(width: 2, height: 2, scale: 1), openedAt: 3, image: "bmV3"
        )
        XCTAssertNotEqual(next.frameId, first.frameId)
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

@MainActor
private final class AnnotationRejectOneSurfaceTransport: SurfAceAnnotationWireTransport {
    let rejectedSurfaceId: String
    var receivedSurfaceIds: [String] = []

    init(rejectedSurfaceId: String) { self.rejectedSurfaceId = rejectedSurfaceId }

    func exchange(_ data: Data) async throws -> Data {
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let op = try XCTUnwrap(request["op"] as? String)
        let id = try XCTUnwrap(request["id"] as? String)
        var reply: [String: Any] = ["v": 1, "type": "response", "op": op, "id": id, "ok": true]
        if op == "annotation.hello" {
            reply["payload"] = ["registryId": "registry-1"]
        } else {
            let payload = try XCTUnwrap(request["payload"] as? [String: Any])
            let record = try XCTUnwrap(payload["record"] as? [String: Any])
            let surfaceId = try XCTUnwrap(record["surfaceId"] as? String)
            receivedSurfaceIds.append(surfaceId)
            if surfaceId == rejectedSurfaceId {
                reply["ok"] = false
                reply["error"] = ["code": "annotation_source_sequence_conflict", "message": "conflict"]
            } else {
                reply["payload"] = [
                    "serverCursor": ["epoch": "0123456789abcdef0123456789abcdef", "sequence": "1"],
                    "duplicate": false, "committedAt": "2026-10-06T23:00:00.000Z",
                ]
            }
        }
        return try JSONSerialization.data(withJSONObject: reply)
    }

    func close() {}
}

extension SurfAceAnnotationOutboxTests {
    @MainActor
    func testPublisherPersistsUnhealthySurfaceAndContinuesOtherSurface() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceAnnotationFault-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority-v1.json"))
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxAnnotationPublisherStateBytesPerSurface = Int64(SurfAceAnnotationOutbox.maximumBytes)
        limits.maxAnnotationPublisherRecordsPerSurface = Int64(SurfAceAnnotationOutbox.maximumRecords)
        limits.maxRecoverableSurfaceBytes = 704 * 1_024 * 1_024
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        state.annotationPublisher = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        let first = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: state.surfaceSetRevision).surface.surfaceId
        let second = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: state.surfaceSetRevision).surface.surfaceId
        let rejected = min(first, second)
        let accepted = max(first, second)
        _ = try state.annotationPublisher?.append(surfaceId: rejected, record: record())
        _ = try state.annotationPublisher?.append(surfaceId: accepted, record: record())
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store, annotationClientId: "client-1")
        let transport = AnnotationRejectOneSurfaceTransport(rejectedSurfaceId: rejected)
        let publisher = try SurfAceAnnotationPublisher(
            adapter: adapter, endpoint: XCTUnwrap(URL(string: "ws://127.0.0.1:19001")),
            makeTransport: { _ in transport }, onError: { _ in }
        )
        try await publisher.drain()
        let saved = try XCTUnwrap(store.load()?.annotationPublisher)
        XCTAssertEqual(transport.receivedSurfaceIds, [rejected, accepted])
        XCTAssertEqual(saved.surfaces[rejected]?.unhealthy?.code, "annotation_source_sequence_conflict")
        XCTAssertEqual(saved.surfaces[rejected]?.fifo.count, 1)
        XCTAssertEqual(saved.surfaces[accepted]?.acceptedCursor?.sequence, "1")
        XCTAssertEqual(saved.publishableSurfaceIds(), [])
        XCTAssertEqual(saved.pendingSurfaceIds(), [rejected])
        publisher.stop()
    }

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
