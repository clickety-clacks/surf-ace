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
}
