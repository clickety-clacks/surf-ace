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

    func testOptionalSubmissionFrontierCannotTurnFittingPayloadIntoGap() throws {
        var final = record(padding: 2_000)
        final["kind"] = "frame_commit"
        var reference = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        _ = try reference.append(surfaceId: surfaceId, record: final)
        XCTAssertEqual(reference.surfaces[surfaceId]?.fifo.first?.kind, "payload")
        // Independent capacity oracle: retain all mandatory canonical/framing state,
        // remove only optional display proof, and reserve both required gap slots.
        reference.surfaces[surfaceId]?.acceptedFramesByPane = nil
        reference.surfaces[surfaceId]?.latestSubmissionByPane = nil
        let limit = Int(try reference.partitionBytes(surfaceId: surfaceId))
            + 2 * SurfAceAnnotationOutbox.gapSlotBytes
        try reference.validate(maxBytes: limit)
        var actual = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        _ = try actual.append(surfaceId: surfaceId, record: final, maxBytes: limit)
        XCTAssertEqual(actual.surfaces[surfaceId]?.fifo.first?.kind, "payload",
                       "optional UI metadata must be reclaimed before dropping fitting canonical source")
        XCTAssertNil(actual.surfaces[surfaceId]?.trailingGap)
        try actual.validate(maxBytes: limit)
    }

    func testPostAppendMetadataReclaimPreservesHeadAndRejectsLateReceipt() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        var final = record(); final["kind"] = "frame_commit"
        _ = try outbox.append(surfaceId: surfaceId, record: final)
        let oldHead = try XCTUnwrap(outbox.head(surfaceId: surfaceId))
        var newer = final; newer["payload"] = ["strokes": [], "padding": String(repeating: "x", count: 2_000)]
        var reference = outbox
        _ = try reference.append(surfaceId: surfaceId, record: newer)
        reference.surfaces[surfaceId]?.acceptedFramesByPane = nil
        reference.surfaces[surfaceId]?.latestSubmissionByPane = nil
        let limit = Int(try reference.partitionBytes(surfaceId: surfaceId))
            + 2 * SurfAceAnnotationOutbox.gapSlotBytes
        _ = try outbox.append(surfaceId: surfaceId, record: newer, maxBytes: limit)
        XCTAssertEqual(outbox.surfaces[surfaceId]?.fifo.count, 2)
        XCTAssertEqual(outbox.surfaces[surfaceId]?.fifo.first, oldHead)
        XCTAssertNil(outbox.surfaces[surfaceId]?.trailingGap)
        XCTAssertNil(outbox.surfaces[surfaceId]?.latestSubmissionByPane)
        XCTAssertEqual(outbox.sourceEpoch, sourceEpoch)
        XCTAssertEqual(outbox.surfaces[surfaceId]?.nextSequence, 3)
        try outbox.validate(maxBytes: limit)
        try outbox.accept(surfaceId: surfaceId, head: oldHead,
                          cursor: .init(epoch: sourceEpoch, sequence: "17"))
        var restored = try JSONDecoder().decode(SurfAceAnnotationOutbox.self, from: JSONEncoder().encode(outbox))
        XCTAssertNil(restored.surfaces[surfaceId]?.acceptedFramesByPane)
        XCTAssertEqual(restored.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "content-1",
                                               revision: 1, hasSavedStrokes: true, diagnostic: [:]), "Waiting to send")
        let newerHead = try XCTUnwrap(restored.head(surfaceId: surfaceId))
        try restored.accept(surfaceId: surfaceId, head: newerHead,
                            cursor: .init(epoch: sourceEpoch, sequence: "18"))
        XCTAssertNil(restored.surfaces[surfaceId]?.acceptedFramesByPane)
        XCTAssertEqual(restored.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "content-1",
                                               revision: 1, hasSavedStrokes: true, diagnostic: [:]), "Saved on device")
        try restored.validate(maxBytes: limit)
        // One byte below mandatory capacity still records genuine source loss.
        var overflow = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        _ = try overflow.append(surfaceId: surfaceId, record: final)
        let retained = try XCTUnwrap(overflow.head(surfaceId: surfaceId))
        _ = try overflow.append(surfaceId: surfaceId, record: newer, maxBytes: limit - 1)
        XCTAssertEqual(overflow.surfaces[surfaceId]?.fifo, [retained])
        XCTAssertEqual(overflow.surfaces[surfaceId]?.trailingGap?.through, "2")
        try overflow.validate(maxBytes: limit - 1)
    }

    func testFinalFrameAcceptanceReceiptSurvivesRestoreAndDoesNotGrowPartition() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        var final = record(); final["kind"] = "frame_commit"
        _ = try outbox.append(surfaceId: surfaceId, record: final)
        let head = try XCTUnwrap(outbox.head(surfaceId: surfaceId))
        XCTAssertNil(outbox.surfaces[surfaceId]?.acceptedFramesByPane)
        let bytes = try outbox.partitionBytes(surfaceId: surfaceId)
        try outbox.accept(surfaceId: surfaceId, head: head,
                          cursor: .init(epoch: sourceEpoch, sequence: "17"))
        XCTAssertLessThanOrEqual(try outbox.partitionBytes(surfaceId: surfaceId), bytes)
        let restored = try JSONDecoder().decode(SurfAceAnnotationOutbox.self,
                                                from: JSONEncoder().encode(outbox))
        let receipt = try XCTUnwrap(restored.surfaces[surfaceId]?.acceptedFramesByPane?["1"])
        XCTAssertEqual(receipt.frameId, final["frameId"] as? String)
        XCTAssertEqual(receipt.contentId, "content-1")
        XCTAssertEqual(receipt.revision, 1)
        XCTAssertEqual(receipt.sourceEventId, head.sourceEventId)
        XCTAssertEqual(receipt.cursor.sequence, "17")
        XCTAssertNil(restored.surfaces[surfaceId]?.acceptedFramesByPane?["2"])
        try restored.validate()
    }

    func testDeltaAcceptanceDoesNotClaimFinalFrameDelivery() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        _ = try outbox.append(surfaceId: surfaceId, record: record())
        let head = try XCTUnwrap(outbox.head(surfaceId: surfaceId))
        try outbox.accept(surfaceId: surfaceId, head: head,
                          cursor: .init(epoch: sourceEpoch, sequence: "1"))
        XCTAssertNil(outbox.surfaces[surfaceId]?.acceptedFramesByPane)
    }

    func testDeliveryStatusRequiresMatchingPaneRevisionAndPersistedFinalReceipt() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        var final = record(); final["kind"] = "frame_commit"
        _ = try outbox.append(surfaceId: surfaceId, record: final)
        let head = try XCTUnwrap(outbox.head(surfaceId: surfaceId))
        func status(_ value: SurfAceAnnotationOutbox, pane: Int = 1, revision: Int = 1,
                    fields: [String: String] = [:]) -> String? {
            value.deliveryStatus(surfaceId: surfaceId, paneId: pane, contentId: "content-1",
                                 revision: revision, hasSavedStrokes: true, diagnostic: fields)
        }
        XCTAssertEqual(status(outbox), "Waiting to send")
        XCTAssertEqual(status(outbox, fields: ["stage": "sent", "surface_id": surfaceId,
                                               "source_event_id": head.sourceEventId]), "Sending")
        XCTAssertEqual(status(outbox, fields: ["stage": "sent", "surface_id": "other",
                                               "source_event_id": head.sourceEventId]), "Waiting to send")
        XCTAssertEqual(status(outbox, fields: ["stage": "registry_accepted", "surface_id": surfaceId,
                                               "source_event_id": head.sourceEventId]), "Waiting to send",
                       "unpersisted acceptance must not become restored delivery proof")
        XCTAssertEqual(status(outbox, fields: ["stage": "processed_ack"]), "Waiting to send")
        try outbox.accept(surfaceId: surfaceId, head: head, cursor: .init(epoch: sourceEpoch, sequence: "9"))
        let restored = try JSONDecoder().decode(SurfAceAnnotationOutbox.self, from: JSONEncoder().encode(outbox))
        XCTAssertEqual(status(restored), "Sent to registry")
        XCTAssertEqual(status(restored, pane: 2), "Saved on device")
        XCTAssertEqual(status(restored, revision: 2), "Saved on device")
        XCTAssertEqual(status(restored, fields: ["stage": "processed_ack"]), "Sent to registry",
                       "no native processed ACK contract exists in this state")
        var later = final; later["frameId"] = "fr_22222222222222222222222222222222"
        _ = try outbox.append(surfaceId: surfaceId, record: later)
        XCTAssertEqual(status(outbox), "Waiting to send", "older final receipt cannot hide a newer frame")
        try outbox.markUnhealthy(surfaceId: surfaceId, code: "internal_error")
        XCTAssertEqual(status(outbox), "Waiting to send — publisher needs recovery")
    }

    @MainActor
    func testDoneAdmissionWaitNoticeFailureAndStaleTimeoutPreserveLocalState() throws {
        let pane = SurfAcePaneModel(paneId: 12, paneLineageId: "pl_done_fixture")
        pane.annotationMode = true
        pane.currentEntry.drawingData = Data([1, 2, 3])
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        let originalEntry = try encoder.encode(pane.currentEntry)
        let generation = try XCTUnwrap(pane.beginAnnotationDone())
        XCTAssertTrue(pane.annotationDoneSpinning)
        XCTAssertNil(pane.beginAnnotationDone(), "double tap must not enter another async transition")
        pane.annotationDoneWaitExpired(generation: generation)
        XCTAssertFalse(pane.annotationDoneSpinning, "a stalled wait cannot spin forever")
        XCTAssertTrue(pane.annotationDonePending)
        XCTAssertNotNil(pane.annotationDoneError)
        XCTAssertNil(pane.beginAnnotationDone(), "timeout does not cancel persistence or reopen admission")
        pane.finishAnnotationDone(generation: generation, failed: true)
        XCTAssertFalse(pane.annotationDonePending)
        XCTAssertFalse(pane.annotationDoneSpinning)
        XCTAssertTrue(pane.annotationMode)
        XCTAssertEqual(try encoder.encode(pane.currentEntry), originalEntry)
        XCTAssertNotNil(pane.annotationDoneError)
        let next = try XCTUnwrap(pane.beginAnnotationDone())
        pane.annotationDoneWaitExpired(generation: generation)
        XCTAssertTrue(pane.annotationDoneSpinning, "a previous wait timer cannot affect a newer attempt")
        XCTAssertNil(pane.annotationDoneError)
        XCTAssertNotEqual(next, generation)
        pane.finishAnnotationDone(generation: next, failed: false, localSaveProven: true)
        XCTAssertFalse(pane.annotationDonePending)
        XCTAssertEqual(pane.annotationDeliveryStatus, "Saved on device")
        XCTAssertNil(pane.annotationDoneError)
    }

    func testOlderLossDiagnosticCannotHideNewFinalAcceptanceOrProveLaterLostFrame() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        try outbox.lose(surfaceId: surfaceId, code: "isolated_loss")
        let gap = try XCTUnwrap(outbox.head(surfaceId: surfaceId))
        try outbox.accept(surfaceId: surfaceId, head: gap, cursor: .init(epoch: sourceEpoch, sequence: "1"))
        var final = record(); final["kind"] = "frame_commit"
        _ = try outbox.append(surfaceId: surfaceId, record: final)
        let head = try XCTUnwrap(outbox.head(surfaceId: surfaceId))
        try outbox.accept(surfaceId: surfaceId, head: head, cursor: .init(epoch: sourceEpoch, sequence: "2"))
        XCTAssertEqual(outbox.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "content-1",
                                            revision: 1, hasSavedStrokes: true), "Sent to registry")
        try outbox.lose(surfaceId: surfaceId, code: "later_loss")
        XCTAssertEqual(outbox.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "content-1",
                                            revision: 1, hasSavedStrokes: true), "Saved on device — delivery incomplete")
    }

    @MainActor
    func testUnprovenLocalCompletionCannotClaimSavedOrRemoteDelivery() throws {
        let pane = SurfAcePaneModel(paneId: 12)
        let generation = try XCTUnwrap(pane.beginAnnotationDone())
        pane.finishAnnotationDone(generation: generation, failed: false)
        XCTAssertFalse(pane.annotationDonePending)
        XCTAssertFalse(pane.annotationDoneSpinning)
        XCTAssertEqual(pane.annotationDeliveryStatus, "Local save not verified")
    }

    @MainActor
    func testDoneCompletionCannotTransferSaveOrFailureToNewContextOrGeneration() throws {
        let pane = SurfAcePaneModel(paneId: 12, paneLineageId: "pl_done_fixture")
        pane.currentEntry.contentId = "content-A"
        pane.currentEntry.revision = 1
        let old = try XCTUnwrap(pane.beginAnnotationDone())
        pane.currentEntry.contentId = "content-B"
        pane.annotationDeliveryStatus = "Waiting to send"
        XCTAssertFalse(pane.finishAnnotationDone(generation: old, failed: false, localSaveProven: true))
        XCTAssertFalse(pane.annotationDonePending)
        XCTAssertEqual(pane.annotationDeliveryStatus, "Waiting to send")
        XCTAssertNil(pane.annotationDoneError)
        let newer = try XCTUnwrap(pane.beginAnnotationDone())
        XCTAssertFalse(pane.finishAnnotationDone(generation: old, failed: true))
        XCTAssertTrue(pane.annotationDonePending)
        XCTAssertTrue(pane.annotationDoneSpinning)
        XCTAssertNil(pane.annotationDoneError)
        XCTAssertTrue(pane.finishAnnotationDone(generation: newer, failed: false, localSaveProven: true))
        XCTAssertEqual(pane.annotationDeliveryStatus, "Saved on device")
        let sameNumbers = try XCTUnwrap(pane.beginAnnotationDone())
        pane.currentEntry.historyOwnerToken = "replacement-history-owner"
        pane.annotationDeliveryStatus = nil
        XCTAssertFalse(pane.finishAnnotationDone(generation: sameNumbers, failed: false, localSaveProven: true))
        XCTAssertNil(pane.annotationDeliveryStatus)
    }

    func testGapAbsorbedNewFrameCannotBorrowOlderPaneAcceptanceOrSurfaceCursor() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        var final = record(); final["kind"] = "frame_commit"
        _ = try outbox.append(surfaceId: surfaceId, record: final, maxRecords: 2)
        let accepted = try XCTUnwrap(outbox.head(surfaceId: surfaceId, maxRecords: 2))
        let cursor = SurfAceAnnotationServerCursor(epoch: sourceEpoch, sequence: "91")
        try outbox.accept(surfaceId: surfaceId, head: accepted, cursor: cursor)
        XCTAssertEqual(outbox.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "content-1",
                                            revision: 1, hasSavedStrokes: true), "Sent to registry")
        var sibling = record(); sibling["paneId"] = 2
        sibling["frameId"] = "fr_22222222222222222222222222222222"
        _ = try outbox.append(surfaceId: surfaceId, record: sibling, maxRecords: 2)
        let preserved = try XCTUnwrap(outbox.surfaces[surfaceId]?.fifo)
        _ = try outbox.append(surfaceId: surfaceId, record: sibling, maxRecords: 2)
        XCTAssertNil(outbox.surfaces[surfaceId]?.diagnostic,
                     "capacity gap must not depend on a diagnostic to invalidate old proof")
        final["frameId"] = "fr_33333333333333333333333333333333"
        _ = try outbox.append(surfaceId: surfaceId, record: final, maxRecords: 2)
        XCTAssertNil(outbox.surfaces[surfaceId]?.acceptedFramesByPane?["1"])
        XCTAssertEqual(outbox.surfaces[surfaceId]?.acceptedCursor, cursor)
        XCTAssertEqual(outbox.surfaces[surfaceId]?.fifo, preserved)
        XCTAssertEqual(outbox.surfaces[surfaceId]?.trailingGap?.through, "4")
        XCTAssertEqual(outbox.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "content-1",
                                            revision: 1, hasSavedStrokes: true), "Saved on device — delivery incomplete")
        try outbox.validate(maxRecords: 2)
    }

    func testLateOldAcceptanceCannotResurrectSentAfterNewerGapDrainAndRestore() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        var final = record(); final["kind"] = "frame_commit"
        _ = try outbox.append(surfaceId: surfaceId, record: final, maxRecords: 2)
        let inFlight = try XCTUnwrap(outbox.head(surfaceId: surfaceId, maxRecords: 2))
        final["frameId"] = "fr_33333333333333333333333333333333"
        _ = try outbox.append(surfaceId: surfaceId, record: final, maxRecords: 2)
        XCTAssertEqual(outbox.surfaces[surfaceId]?.trailingGap?.through, "2")
        let cursor = SurfAceAnnotationServerCursor(epoch: sourceEpoch, sequence: "91")
        try outbox.accept(surfaceId: surfaceId, head: inFlight, cursor: cursor)
        XCTAssertNil(outbox.surfaces[surfaceId]?.acceptedFramesByPane?["1"])
        XCTAssertEqual(outbox.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "content-1",
                                            revision: 1, hasSavedStrokes: true), "Saved on device — delivery incomplete")
        let gap = try XCTUnwrap(outbox.head(surfaceId: surfaceId, maxRecords: 2))
        try outbox.accept(surfaceId: surfaceId, head: gap, cursor: .init(epoch: sourceEpoch, sequence: "92"))
        outbox = try JSONDecoder().decode(SurfAceAnnotationOutbox.self, from: JSONEncoder().encode(outbox))
        XCTAssertEqual(outbox.surfaces[surfaceId]?.latestSubmissionByPane?["1"]?.sourceSequence, "2")
        XCTAssertEqual(outbox.surfaces[surfaceId]?.latestSubmissionByPane?["1"]?.contentId, "content-1")
        XCTAssertEqual(outbox.surfaces[surfaceId]?.latestSubmissionByPane?["1"]?.revision, 1)
        XCTAssertNil(outbox.surfaces[surfaceId]?.acceptedFramesByPane?["1"])
        XCTAssertNotEqual(outbox.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "content-1",
                                               revision: 1, hasSavedStrokes: true), "Sent to registry")
        XCTAssertEqual(outbox.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "content-1",
                                            revision: 1, hasSavedStrokes: true), "Saved on device — delivery incomplete")
        XCTAssertEqual(outbox.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "content-1",
                                            revision: 2, hasSavedStrokes: true), "Saved on device")
        XCTAssertEqual(outbox.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "other-content",
                                            revision: 1, hasSavedStrokes: true), "Saved on device")
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(outbox)) as? [String: Any])
        var surfaces = try XCTUnwrap(json["surfaces"] as? [String: Any])
        var storedSurface = try XCTUnwrap(surfaces[surfaceId] as? [String: Any])
        storedSurface["latestSubmissionByPane"] = ["1": "2"]
        surfaces[surfaceId] = storedSurface; json["surfaces"] = surfaces
        let legacy = try JSONDecoder().decode(SurfAceAnnotationOutbox.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(legacy.surfaces[surfaceId]?.latestSubmissionByPane?["1"]?.sourceSequence, "2")
        XCTAssertNil(legacy.surfaces[surfaceId]?.latestSubmissionByPane?["1"]?.contentId)
        XCTAssertNotEqual(legacy.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "content-1",
                                               revision: 1, hasSavedStrokes: true), "Sent to registry")
        // A genuinely newer final frame can still establish its own proof.
        _ = try outbox.append(surfaceId: surfaceId, record: final, maxRecords: 2)
        let newer = try XCTUnwrap(outbox.head(surfaceId: surfaceId, maxRecords: 2))
        try outbox.accept(surfaceId: surfaceId, head: newer, cursor: .init(epoch: sourceEpoch, sequence: "93"))
        XCTAssertEqual(outbox.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "content-1",
                                            revision: 1, hasSavedStrokes: true), "Sent to registry")
        try outbox.validate(maxRecords: 2)
    }

    func testLateAcceptanceRetainsSiblingProofAcrossOtherPaneLoss() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        var final = record(); final["kind"] = "frame_commit"
        _ = try outbox.append(surfaceId: surfaceId, record: final, maxRecords: 2)
        let inFlight = try XCTUnwrap(outbox.head(surfaceId: surfaceId, maxRecords: 2))
        final["paneId"] = 2
        _ = try outbox.append(surfaceId: surfaceId, record: final, maxRecords: 2)
        try outbox.accept(surfaceId: surfaceId, head: inFlight, cursor: .init(epoch: sourceEpoch, sequence: "91"))
        let gap = try XCTUnwrap(outbox.head(surfaceId: surfaceId, maxRecords: 2))
        try outbox.accept(surfaceId: surfaceId, head: gap, cursor: .init(epoch: sourceEpoch, sequence: "92"))
        let restored = try JSONDecoder().decode(SurfAceAnnotationOutbox.self, from: JSONEncoder().encode(outbox))
        XCTAssertEqual(restored.deliveryStatus(surfaceId: surfaceId, paneId: 1, contentId: "content-1",
                                              revision: 1, hasSavedStrokes: true), "Sent to registry")
        XCTAssertNotEqual(restored.deliveryStatus(surfaceId: surfaceId, paneId: 2, contentId: "content-1",
                                                 revision: 1, hasSavedStrokes: true), "Sent to registry")
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

    func testTrailingGapKeepsItsFullSlotWhileAnOpenFrameGrows() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        _ = try outbox.append(surfaceId: surfaceId, record: record(), maxBytes: 22_000)
        let payload = try XCTUnwrap(outbox.head(surfaceId: surfaceId, maxBytes: 22_000))
        _ = try outbox.append(surfaceId: surfaceId, record: record(padding: 20_000), maxBytes: 22_000)
        XCTAssertNotNil(outbox.surfaces[surfaceId]?.trailingGap)
        let occupied = Int(try outbox.partitionBytes(surfaceId: surfaceId))
        let limit = occupied + SurfAceAnnotationOutbox.gapSlotBytes + 10_500
        let frame = try outbox.beginFrame(
            surfaceId: surfaceId, paneId: 1, contextKey: "content-1", contentId: "content-1",
            url: nil, scrollOffset: .init(x: 0, y: 0),
            viewport: .init(width: 1, height: 1, scale: 1), openedAt: 1,
            image: String(repeating: "x", count: 9_500), maxBytes: limit
        )
        XCTAssertTrue(frame.failed, "the occupied trailing gap retains its full byte reservation")
        try outbox.validate(maxBytes: limit)
        try outbox.accept(surfaceId: surfaceId, head: payload,
                          cursor: .init(epoch: sourceEpoch, sequence: "1"))
        XCTAssertEqual(try outbox.head(surfaceId: surfaceId, maxBytes: limit)?.kind, "gap")
        try outbox.validate(maxBytes: limit)
    }

    func testUnstagedDirectBoundaryRetiresItsFrameIntoPendingSourceLoss() throws {
        var outbox = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        let first = try outbox.beginFrame(
            surfaceId: surfaceId, paneId: 1, contextKey: "content-1", contentId: "content-1",
            url: nil, scrollOffset: .init(x: 0, y: 0),
            viewport: .init(width: 1, height: 1, scale: 1), openedAt: 1, image: "aW1hZ2U="
        )
        outbox.setFrameCommitRequested(surfaceId: surfaceId, paneId: 1, requested: true)
        XCTAssertTrue(try outbox.abandonUnstagedDirectFrame(
            surfaceId: surfaceId, paneId: 1, frameId: first.frameId))
        XCTAssertNil(outbox.openFrame(surfaceId: surfaceId, paneId: 1))
        XCTAssertNotNil(outbox.surfaces[surfaceId]?.trailingGap)
        XCTAssertNil(outbox.surfaces[surfaceId]?.unhealthy)
        XCTAssertEqual(outbox.surfaces[surfaceId]?.diagnostic?.code,
                       "annotation_direct_stage_unavailable")
        XCTAssertEqual(outbox.publishableSurfaceIds(), [surfaceId])
        let second = try outbox.beginFrame(
            surfaceId: surfaceId, paneId: 1, contextKey: "content-1", contentId: "content-1",
            url: nil, scrollOffset: .init(x: 0, y: 0),
            viewport: .init(width: 1, height: 1, scale: 1), openedAt: 2, image: "aW1hZ2U="
        )
        XCTAssertNotEqual(second.frameId, first.frameId)
        XCTAssertFalse(try outbox.abandonUnstagedDirectFrame(
            surfaceId: surfaceId, paneId: 1, frameId: first.frameId))
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

    func testPublisherLimitsValidateAndRoundTrip() throws {
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxAnnotationPublisherStateBytesPerSurface = Int64(SurfAceAnnotationOutbox.maximumBytes)
        limits.maxAnnotationPublisherRecordsPerSurface = Int64(SurfAceAnnotationOutbox.maximumRecords)
        XCTAssertEqual(limits.maxAnnotationPublisherStateBytesPerSurface,
                       Int64(SurfAceAnnotationOutbox.maximumBytes))
        XCTAssertEqual(limits.maxAnnotationPublisherRecordsPerSurface,
                       Int64(SurfAceAnnotationOutbox.maximumRecords))
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

    func testRetainedTombstonesPreserveUnacceptedSourcePartition() throws {
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
        XCTAssertEqual(state.surfaceTombstones.map { $0.surface.surfaceId },
                       [first.surface.surfaceId, second.surface.surfaceId])
        XCTAssertEqual(state.surfaceTombstones.first?.surface, first.surface)
        XCTAssertEqual(state.annotationPublisher?.surfaces[first.surface.surfaceId]?.fifo.first, pending)
        XCTAssertTrue((state.pendingTombstoneReclamations ?? []).isEmpty)
        let restored = try JSONDecoder().decode(SurfAceLocklessAuthorityState.self,
                                                from: JSONEncoder().encode(state))
        try restored.validate()
        XCTAssertEqual(restored, state)
        XCTAssertEqual(restored.annotationPublisher?.surfaces[first.surface.surfaceId]?.fifo.first, pending)
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
private final class AnnotationAmbiguousServerProbe {
    enum Failure { case beforeCommit, afterCommit, lostReply, hello }
    let failure: Failure
    var failed = false
    var operations: [String] = []
    var attemptedCanonicals: [String] = []
    var committedCanonicals: [String] = []
    var duplicates = 0
    var connections = 0
    var closedConnections = 0
    init(_ failure: Failure) { self.failure = failure }
}

@MainActor
private final class AnnotationAmbiguousServerTransport: SurfAceAnnotationWireTransport {
    let probe: AnnotationAmbiguousServerProbe
    private var roleEstablished = false
    init(_ probe: AnnotationAmbiguousServerProbe) { self.probe = probe; probe.connections += 1 }
    func exchange(_ data: Data) async throws -> Data {
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let op = try XCTUnwrap(request["op"] as? String)
        probe.operations.append(op)
        var reply: [String: Any] = ["v": 1, "type": "response", "op": op, "id": request["id"]!, "ok": true]
        if op == "annotation.hello" {
            if probe.failure == .hello && !probe.failed {
                probe.failed = true
                reply["ok"] = false; reply["error"] = ["code": "internal_error"]
            } else {
                roleEstablished = true
                reply["payload"] = ["registryId": "isolated-registry"]
            }
        } else {
            XCTAssertTrue(roleEstablished, "each replacement connection must hello before ingestion")
            let payload = try XCTUnwrap(request["payload"] as? [String: Any])
            let record = try XCTUnwrap(payload["record"] as? [String: Any])
            let canonical = try XCTUnwrap(SurfAceAnnotationOutbox.canonical(record))
            probe.attemptedCanonicals.append(canonical)
            if probe.failure == .beforeCommit && !probe.failed {
                probe.failed = true
                reply["ok"] = false; reply["error"] = ["code": "internal_error"]
            } else {
                let duplicate = probe.committedCanonicals.contains(canonical)
                if duplicate { probe.duplicates += 1 } else { probe.committedCanonicals.append(canonical) }
                if !probe.failed && (probe.failure == .afterCommit || probe.failure == .lostReply) {
                    probe.failed = true
                    if probe.failure == .lostReply { throw URLError(.networkConnectionLost) }
                    reply["ok"] = false; reply["error"] = ["code": "internal_error"]
                } else {
                    let cursor = try XCTUnwrap(probe.committedCanonicals.firstIndex(of: canonical)) + 1
                    reply["payload"] = ["serverCursor": ["epoch": "0123456789abcdef0123456789abcdef", "sequence": String(cursor)],
                                        "duplicate": duplicate, "committedAt": "2026-10-13T02:00:00.000Z"]
                }
            }
        }
        return try JSONSerialization.data(withJSONObject: reply)
    }
    func close() { roleEstablished = false; probe.closedConnections += 1 }
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
private final class AnnotationRoleEnforcingTransport: SurfAceAnnotationWireTransport {
    var operations: [String] = []
    var records: [String] = []
    var roleEstablished = false
    func exchange(_ data: Data) async throws -> Data {
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let op = try XCTUnwrap(request["op"] as? String)
        operations.append(op)
        var reply: [String: Any] = ["v": 1, "type": "response", "op": op,
                                    "id": request["id"]!, "ok": true]
        if op == "annotation.hello" {
            roleEstablished = true
            reply["payload"] = ["registryId": "fixture-registry"]
        } else if !roleEstablished {
            reply["ok"] = false
            reply["error"] = ["code": "annotation_role_operation_invalid", "message": "hello required"]
        } else {
            let payload = try XCTUnwrap(request["payload"] as? [String: Any])
            let record = try XCTUnwrap(payload["record"] as? [String: Any])
            records.append(String(decoding: try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]), as: UTF8.self))
            reply["payload"] = ["serverCursor": ["epoch": "0123456789abcdef0123456789abcdef", "sequence": String(records.count)],
                                "duplicate": false, "committedAt": "2026-10-10T17:00:00.000Z"]
        }
        return try JSONSerialization.data(withJSONObject: reply)
    }
    func close() { roleEstablished = false }
}

@MainActor
private final class AnnotationRoleSocketServer {
    let server = SurfAceHTTPServer()
    let marker = UUID().uuidString
    var connections: [AnnotationRoleEnforcingTransport] = []
    func start() async throws -> URL {
        let marker = self.marker
        let port = try await server.startIsolatedLoopbackForTesting(
            httpHandler: { _ in HTTPServerResponse(statusCode: 200, body: Data(marker.utf8)) },
            webSocketHandler: { [self] socket in await serve(socket) }
        )
        XCTAssertNotEqual(port, SurfAceHTTPServer.fixedPort)
        let identity = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/identity"))
        let (data, _) = try await URLSession.shared.data(from: identity)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), marker)
        return try XCTUnwrap(URL(string: "ws://127.0.0.1:\(port)/ws"))
    }
    private func serve(_ socket: SurfAceWebSocket) async {
        let connection = AnnotationRoleEnforcingTransport()
        connections.append(connection)
        do {
            while let message = try await socket.receive() {
                guard case .text(let text) = message else { break }
                let reply = try await connection.exchange(Data(text.utf8))
                try await socket.send(text: String(decoding: reply, as: UTF8.self))
            }
        } catch { /* The owned publisher closes its connection during rebind. */ }
    }
    func stop() async { await server.stop() }
}

@MainActor
private final class AnnotationSuspendedHelloTransport: SurfAceAnnotationWireTransport {
    var entered: CheckedContinuation<Void, Never>?
    var response: CheckedContinuation<Void, Never>?
    func exchange(_ data: Data) async throws -> Data {
        entered?.resume()
        entered = nil
        await withCheckedContinuation { response = $0 }
        let request = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        return try JSONSerialization.data(withJSONObject: [
            "v": 1, "type": "response", "op": request["op"]!, "id": request["id"]!,
            "ok": true, "payload": ["registryId": "old-registry"]
        ])
    }
    func close() {}
}

@MainActor
private final class AnnotationRejectOneSurfaceTransport: SurfAceAnnotationWireTransport {
    let rejectedSurfaceId: String
    let rejectedCode: String
    var receivedSurfaceIds: [String] = []

    init(rejectedSurfaceId: String,
         rejectedCode: String = "annotation_source_sequence_conflict") {
        self.rejectedSurfaceId = rejectedSurfaceId
        self.rejectedCode = rejectedCode
    }

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
                reply["error"] = ["code": rejectedCode, "message": "rejected"]
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
    private func assertAmbiguousServerFailurePreservesCrossPaneFIFO(
        _ failure: AnnotationAmbiguousServerProbe.Failure, gap: Bool = false
    ) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceInternalError-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority.json"))
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxAnnotationPublisherStateBytesPerSurface = Int64(SurfAceAnnotationOutbox.maximumBytes)
        limits.maxAnnotationPublisherRecordsPerSurface = Int64(SurfAceAnnotationOutbox.maximumRecords)
        limits.maxRecoverableSurfaceBytes = 704 * 1_024 * 1_024
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        state.annotationPublisher = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: state.surfaceSetRevision)
        let sid = opened.surface.surfaceId
        let firstPane = try XCTUnwrap(opened.surface.panes.values.first).paneId
        _ = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: sid, paneId: firstPane, count: 2,
            direction: "horizontal", expectedTopologyRevision: opened.surface.topologyRevision)
        let panes = try XCTUnwrap(state.liveSurfaces[sid]).panes.values.map(\.paneId).sorted()
        XCTAssertEqual(panes.count, 2)
        if gap {
            try state.annotationPublisher?.lose(surfaceId: sid, code: "isolated_gap")
            _ = try state.annotationPublisher?.head(surfaceId: sid)
        } else {
            for (index, paneId) in panes.enumerated() {
                var source = record(); source["paneId"] = Int(paneId)
                source["frameId"] = "fr_\(String(repeating: String(index + 1), count: 32))"
                _ = try state.annotationPublisher?.append(surfaceId: sid, record: source)
            }
        }
        let expected = try XCTUnwrap(state.annotationPublisher?.surfaces[sid]?.fifo)
        guard expected.count == (gap ? 1 : 2) else {
            XCTFail("fixture records must be valid payloads before testing transport faults")
            return
        }
        let preservedLive = try JSONEncoder().encode(state.liveSurfaces)
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store, annotationClientId: "client-1")
        let probe = AnnotationAmbiguousServerProbe(failure)
        var diagnostics: [[String: String]] = []
        let failed = expectation(description: "bounded retry scheduled after ambiguous server failure")
        let first = try SurfAceAnnotationPublisher(
            adapter: adapter, endpoint: XCTUnwrap(URL(string: "ws://127.0.0.1:1/ws")),
            makeTransport: { _ in AnnotationAmbiguousServerTransport(probe) },
            onDiagnostic: { diagnostics.append($0) }, onError: { _ in failed.fulfill() })
        first.notify()
        await fulfillment(of: [failed], timeout: 5)
        await first.awaitIdle()
        first.stop() // Cancel the retry timer; this test controls the next connection.
        let pending = await adapter.snapshot()
        XCTAssertNil(pending.annotationPublisher?.surfaces[sid]?.unhealthy)
        XCTAssertNil(pending.annotationPublisher?.surfaces[sid]?.acceptedCursor)
        XCTAssertEqual(pending.annotationPublisher?.surfaces[sid]?.fifo.map(\.canonical), expected.map(\.canonical))
        XCTAssertEqual(pending.annotationPublisher?.surfaces[sid]?.fifo.map(\.sourceEventId), expected.map(\.sourceEventId))
        XCTAssertTrue(diagnostics.contains { $0["stage"] == "retry_scheduled" })
        XCTAssertEqual(probe.attemptedCanonicals.count, failure == .hello ? 0 : 1,
                       "later pane must not bypass an uncertain FIFO head")
        let resumedAdapter = try SurfAceLocklessRuntimeAdapter(store: store, annotationClientId: "client-1")
        let resumed = try SurfAceAnnotationPublisher(
            adapter: resumedAdapter, endpoint: XCTUnwrap(URL(string: "ws://127.0.0.1:1/ws")),
            makeTransport: { _ in AnnotationAmbiguousServerTransport(probe) }, onError: { _ in XCTFail("retry failed") })
        try await resumed.drain(); resumed.stop()
        let saved = try XCTUnwrap(store.load())
        XCTAssertEqual(probe.connections, 2)
        XCTAssertEqual(probe.operations.filter { $0 == "annotation.hello" }.count, 2)
        XCTAssertEqual(probe.committedCanonicals, expected.map(\.canonical))
        let expectedAttempts = (failure == .hello ? [] : [expected[0].canonical]) + expected.map(\.canonical)
        XCTAssertEqual(probe.attemptedCanonicals, expectedAttempts)
        XCTAssertEqual(probe.duplicates, failure == .afterCommit || failure == .lostReply ? 1 : 0)
        XCTAssertEqual(saved.annotationPublisher?.surfaces[sid]?.fifo.count, 0)
        XCTAssertNil(saved.annotationPublisher?.surfaces[sid]?.unhealthy)
        XCTAssertEqual(saved.annotationPublisher?.surfaces[sid]?.acceptedCursor?.sequence, String(expected.count))
        XCTAssertEqual(saved.annotationPublisher?.clientId, "client-1")
        XCTAssertEqual(saved.annotationPublisher?.sourceEpoch, sourceEpoch)
        let finalLive = try JSONEncoder().encode(saved.liveSurfaces)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: finalLive) as? NSDictionary,
                       try JSONSerialization.jsonObject(with: preservedLive) as? NSDictionary)
    }
    @MainActor func testInternalErrorBeforeCommitRetainsSameHeadAndLaterPaneFIFO() async throws {
        try await assertAmbiguousServerFailurePreservesCrossPaneFIFO(.beforeCommit)
    }
    @MainActor func testInternalErrorAfterCommitRetriesDuplicateWithoutNewFrameOrHistory() async throws {
        try await assertAmbiguousServerFailurePreservesCrossPaneFIFO(.afterCommit)
    }
    @MainActor func testCommittedButReplyLostPreservesCrossPaneFIFOAndDeduplicates() async throws {
        try await assertAmbiguousServerFailurePreservesCrossPaneFIFO(.lostReply)
    }
    @MainActor func testInternalErrorHelloDoesNotPoisonSurfaceOrAllocateSourceIdentity() async throws {
        try await assertAmbiguousServerFailurePreservesCrossPaneFIFO(.hello)
    }
    @MainActor func testInternalErrorSourceGapRetriesSameCanonicalGap() async throws {
        try await assertAmbiguousServerFailurePreservesCrossPaneFIFO(.afterCommit, gap: true)
    }
    @MainActor
    func testPreviouslyPoisonedSurfaceAndDistinctLaterFramesRemainUntouched() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceExistingPoison-\(UUID().uuidString)", isDirectory: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(stateURL: directory.appendingPathComponent("authority.json"))
        var limits = SurfAceLocklessCapacityLimits.production
        limits.maxAnnotationPublisherStateBytesPerSurface = Int64(SurfAceAnnotationOutbox.maximumBytes)
        limits.maxAnnotationPublisherRecordsPerSurface = Int64(SurfAceAnnotationOutbox.maximumRecords)
        limits.maxRecoverableSurfaceBytes = 704 * 1_024 * 1_024
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        state.annotationPublisher = try SurfAceAnnotationOutbox(clientId: "client-1", sourceEpoch: sourceEpoch)
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: state.surfaceSetRevision)
        let sid = opened.surface.surfaceId
        _ = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: sid, paneId: try XCTUnwrap(opened.surface.panes.values.first).paneId,
            count: 2, direction: "horizontal", expectedTopologyRevision: opened.surface.topologyRevision)
        let panes = try XCTUnwrap(state.liveSurfaces[sid]).panes.values.map(\.paneId).sorted()
        var earlier = record(); earlier["paneId"] = Int(panes[0])
        _ = try state.annotationPublisher?.append(surfaceId: sid, record: earlier)
        try state.annotationPublisher?.markUnhealthy(surfaceId: sid, code: "internal_error")
        var later = record(); later["paneId"] = Int(panes[1])
        later["frameId"] = "fr_22222222222222222222222222222222"
        _ = try state.annotationPublisher?.append(surfaceId: sid, record: later)
        let expected = try XCTUnwrap(state.annotationPublisher?.surfaces[sid])
        guard expected.fifo.count == 2 else {
            XCTFail("fixture must retain distinct earlier and later payloads")
            return
        }
        XCTAssertNotEqual(expected.fifo[0].sourceEventId, expected.fifo[1].sourceEventId)
        XCTAssertNotEqual(expected.fifo[0].canonical, expected.fifo[1].canonical)
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store, annotationClientId: "client-1")
        let probe = AnnotationAmbiguousServerProbe(.beforeCommit)
        let publisher = try SurfAceAnnotationPublisher(
            adapter: adapter, endpoint: XCTUnwrap(URL(string: "ws://127.0.0.1:1/ws")),
            makeTransport: { _ in AnnotationAmbiguousServerTransport(probe) }, onError: { _ in XCTFail("unexpected send") })
        try await publisher.drain(); publisher.stop()
        let saved = try XCTUnwrap(store.load())
        XCTAssertEqual(probe.connections, 0, "prevention fix cannot automatically reopen or replay existing poison")
        XCTAssertEqual(saved.annotationPublisher?.surfaces[sid]?.unhealthy, expected.unhealthy)
        XCTAssertEqual(saved.annotationPublisher?.surfaces[sid]?.fifo, expected.fifo)
        XCTAssertEqual(saved.annotationPublisher?.surfaces[sid]?.nextSequence, expected.nextSequence)
        XCTAssertNil(saved.annotationPublisher?.surfaces[sid]?.acceptedCursor)
    }
    @MainActor
    func testRejectedGapPersistsUnhealthyAndDoesNotBlockOtherSurface() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceAnnotationRejectedGap-\(UUID().uuidString)", isDirectory: true)
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
        try state.annotationPublisher?.lose(surfaceId: rejected, code: "annotation_source_strokes_unavailable")
        _ = try state.annotationPublisher?.append(surfaceId: accepted, record: record())
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store, annotationClientId: "client-1")
        let transport = AnnotationRejectOneSurfaceTransport(
            rejectedSurfaceId: rejected, rejectedCode: "annotation_invalid_request"
        )
        let publisher = try SurfAceAnnotationPublisher(
            adapter: adapter, endpoint: XCTUnwrap(URL(string: "ws://127.0.0.1:19001")),
            makeTransport: { _ in transport }, onError: { _ in }
        )
        try await publisher.drain()
        let saved = try XCTUnwrap(store.load()?.annotationPublisher)
        XCTAssertEqual(transport.receivedSurfaceIds, [rejected, accepted])
        XCTAssertEqual(saved.surfaces[rejected]?.unhealthy?.code, "annotation_invalid_request")
        XCTAssertEqual(saved.surfaces[rejected]?.fifo.first?.kind, "gap")
        XCTAssertNil(saved.surfaces[rejected]?.acceptedCursor)
        XCTAssertEqual(saved.surfaces[accepted]?.acceptedCursor?.sequence, "1")
        XCTAssertEqual(saved.pendingSurfaceIds(), [rejected])
        publisher.stop()
    }

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
        let firstPublisher = try SurfAceAnnotationPublisher(
            adapter: adapter, endpoint: XCTUnwrap(URL(string: "ws://127.0.0.1:19001")),
            makeTransport: { _ in AnnotationWireProbeTransport(probe) }, onError: { _ in }
        )
        do {
            try await firstPublisher.drain()
            XCTFail("the first send must lose its response")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost)
        }
        firstPublisher.stop()
        let afterAmbiguousSend = await adapter.snapshot()
        XCTAssertNil(afterAmbiguousSend.annotationPublisher?.surfaces[surfaceId]?.acceptedCursor)
        let restartedPublisher = try SurfAceAnnotationPublisher(
            adapter: adapter, endpoint: XCTUnwrap(URL(string: "ws://127.0.0.1:19001")),
            makeTransport: { _ in AnnotationWireProbeTransport(probe) }, onError: { _ in }
        )
        try await restartedPublisher.drain()
        restartedPublisher.stop()
        XCTAssertGreaterThanOrEqual(probe.connections, 2)
        XCTAssertEqual(probe.records, [expected.canonical, expected.canonical])
        let saved = try XCTUnwrap(store.load())
        XCTAssertEqual(saved.annotationPublisher?.surfaces[surfaceId]?.acceptedCursor?.sequence, "1")
        XCTAssertEqual(saved.annotationPublisher?.pendingSurfaceIds(), [])
    }

    @MainActor
    func testVerifiedRouteChangeRetriesSamePersistedHeadAfterAmbiguousDisconnect() async throws {
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
        var endpoints: [URL] = []
        var diagnostics: [[String: String]] = []
        let firstPublisher = try SurfAceAnnotationPublisher(
            adapter: adapter, endpoint: XCTUnwrap(URL(string: "ws://127.0.0.1:19001")),
            makeTransport: { endpoint in endpoints.append(endpoint); return AnnotationWireProbeTransport(probe) }, onDiagnostic: { diagnostics.append($0) }, onError: { _ in }
        )
        do {
            try await firstPublisher.drain()
            XCTFail("the first send must lose its response")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .networkConnectionLost)
        }
        let afterAmbiguousSend = await adapter.snapshot()
        XCTAssertNil(afterAmbiguousSend.annotationPublisher?.surfaces[surfaceId]?.acceptedCursor)
        let selected = try XCTUnwrap(URL(string: "ws://127.0.0.1:29999/ws"))
        try firstPublisher.reconcileEndpoint(selected)
        await firstPublisher.awaitIdle()
        firstPublisher.stop()
        XCTAssertEqual(endpoints.last, selected)
        XCTAssertGreaterThanOrEqual(probe.connections, 2)
        XCTAssertEqual(probe.records, [expected.canonical, expected.canonical])
        let saved = try XCTUnwrap(store.load())
        XCTAssertEqual(saved.annotationPublisher?.surfaces[surfaceId]?.acceptedCursor?.sequence, "1")
        XCTAssertEqual(saved.annotationPublisher?.pendingSurfaceIds(), [])
        XCTAssertEqual(saved.annotationPublisher?.clientId, "client-1")
        XCTAssertEqual(saved.annotationPublisher?.sourceEpoch, sourceEpoch)
        let sends = diagnostics.filter { $0["stage"] == "sent" }
        XCTAssertEqual(sends.count, 2)
        XCTAssertEqual(sends.map { $0["source_event_id"] }, [expected.sourceEventId, expected.sourceEventId])
        XCTAssertEqual(diagnostics.filter { $0["stage"] == "acceptance_persisted" }.count, 1)
        XCTAssertTrue(diagnostics.allSatisfy { $0["at"] != nil && $0["payload"] == nil && $0["canonical"] == nil })
        let secretURL = try XCTUnwrap(URL(string: "wss://name:password@example.test:443/private-token?secret=value#fragment"))
        XCTAssertEqual(SurfAceAnnotationPublisher.safeEndpoint(secretURL), "wss://example.test:443")
    }

    @MainActor
    func testHeldDurableHeadRebindRequiresHelloAndPreservesLaterFIFO() async throws {
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
        let oldTransport = AnnotationRoleEnforcingTransport()
        let newTransport = AnnotationRoleEnforcingTransport()
        let old = try XCTUnwrap(URL(string: "ws://127.0.0.1:29998/ws"))
        let selected = try XCTUnwrap(URL(string: "ws://127.0.0.1:29999/ws"))
        let held = expectation(description: "durable head completion held after valid A hello")
        var release: CheckedContinuation<Void, Never>?
        var holdOnce = true
        var errors: [Error] = []
        let publisher = try SurfAceAnnotationPublisher(
            adapter: adapter, endpoint: old,
            makeTransport: { $0 == old ? oldTransport : newTransport },
            headAcquisitionCompletionForTesting: {
                guard holdOnce else { return }
                holdOnce = false
                await withCheckedContinuation { continuation in
                    release = continuation
                    held.fulfill()
                }
            }, onError: { errors.append($0) }
        )
        publisher.notify()
        await fulfillment(of: [held], timeout: 5)
        XCTAssertEqual(oldTransport.operations, ["annotation.hello"])
        let heldSnapshot = await adapter.snapshot()
        let canonical = try XCTUnwrap(heldSnapshot.annotationPublisher?.surfaces[surfaceId]?.fifo.first?.canonical)
        XCTAssertEqual(canonical, expected.canonical)
        try publisher.reconcileEndpoint(selected)
        release?.resume()
        release = nil
        await publisher.awaitIdle()
        XCTAssertEqual(newTransport.operations, ["annotation.hello", "annotation.ingest"])
        XCTAssertEqual(newTransport.records, [expected.canonical])
        XCTAssertTrue(errors.isEmpty)
        var saved = try XCTUnwrap(store.load())
        XCTAssertNil(saved.annotationPublisher?.surfaces[surfaceId]?.unhealthy)
        XCTAssertEqual(saved.annotationPublisher?.pendingSurfaceIds(), [])
        let laterRecordData = try JSONSerialization.data(withJSONObject: record())
        let later = try await adapter.transactAnnotationPublisher(surfaceId: surfaceId) { outbox in
            let laterRecord = try XCTUnwrap(JSONSerialization.jsonObject(with: laterRecordData) as? [String: Any])
            _ = try outbox.append(surfaceId: surfaceId, record: laterRecord)
            return try outbox.head(surfaceId: surfaceId)
        }
        publisher.notify()
        await publisher.awaitIdle()
        publisher.stop()
        XCTAssertEqual(newTransport.operations, ["annotation.hello", "annotation.ingest", "annotation.ingest"])
        XCTAssertEqual(newTransport.records, [expected.canonical, try XCTUnwrap(later).canonical])
        saved = try XCTUnwrap(store.load())
        XCTAssertNil(saved.annotationPublisher?.surfaces[surfaceId]?.unhealthy)
        XCTAssertEqual(saved.annotationPublisher?.pendingSurfaceIds(), [])
        XCTAssertEqual(saved.annotationPublisher?.sourceEpoch, sourceEpoch)
        XCTAssertEqual(saved.annotationPublisher?.clientId, "client-1")
    }

    @MainActor
    func testRealSocketHeldHeadRebindRequiresPerConnectionHello() async throws {
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
        let oldServer = AnnotationRoleSocketServer()
        let newServer = AnnotationRoleSocketServer()
        addTeardownBlock { await oldServer.stop(); await newServer.stop() }
        let old = try await oldServer.start()
        let selected = try await newServer.start()
        let held = expectation(description: "durable head completion held after valid A hello")
        var release: CheckedContinuation<Void, Never>?
        var holdOnce = true
        var errors: [Error] = []
        let publisher = try SurfAceAnnotationPublisher(
            adapter: adapter, endpoint: old,
            headAcquisitionCompletionForTesting: {
                guard holdOnce else { return }
                holdOnce = false
                await withCheckedContinuation { continuation in
                    release = continuation
                    held.fulfill()
                }
            }, onError: { errors.append($0) }
        )
        addTeardownBlock { await MainActor.run { publisher.stop() } }
        publisher.notify()
        await fulfillment(of: [held], timeout: 5)
        let oldTransport = try XCTUnwrap(oldServer.connections.first)
        XCTAssertEqual(oldTransport.operations, ["annotation.hello"])
        let heldSnapshot = await adapter.snapshot()
        let canonical = try XCTUnwrap(heldSnapshot.annotationPublisher?.surfaces[surfaceId]?.fifo.first?.canonical)
        XCTAssertEqual(canonical, expected.canonical)
        try publisher.reconcileEndpoint(selected)
        release?.resume()
        release = nil
        await publisher.awaitIdle()
        let newTransport = try XCTUnwrap(newServer.connections.first)
        XCTAssertEqual(newTransport.operations, ["annotation.hello", "annotation.ingest"])
        XCTAssertEqual(newTransport.records, [expected.canonical])
        XCTAssertTrue(errors.isEmpty)
        var saved = try XCTUnwrap(store.load())
        XCTAssertNil(saved.annotationPublisher?.surfaces[surfaceId]?.unhealthy)
        XCTAssertEqual(saved.annotationPublisher?.pendingSurfaceIds(), [])
        let laterRecordData = try JSONSerialization.data(withJSONObject: record())
        let later = try await adapter.transactAnnotationPublisher(surfaceId: surfaceId) { outbox in
            let laterRecord = try XCTUnwrap(JSONSerialization.jsonObject(with: laterRecordData) as? [String: Any])
            _ = try outbox.append(surfaceId: surfaceId, record: laterRecord)
            return try outbox.head(surfaceId: surfaceId)
        }
        publisher.notify()
        await publisher.awaitIdle()
        publisher.stop()
        XCTAssertEqual(newTransport.operations, ["annotation.hello", "annotation.ingest", "annotation.ingest"])
        XCTAssertEqual(newTransport.records, [expected.canonical, try XCTUnwrap(later).canonical])
        saved = try XCTUnwrap(store.load())
        XCTAssertNil(saved.annotationPublisher?.surfaces[surfaceId]?.unhealthy)
        XCTAssertEqual(saved.annotationPublisher?.pendingSurfaceIds(), [])
        XCTAssertEqual(saved.annotationPublisher?.sourceEpoch, sourceEpoch)
        XCTAssertEqual(saved.annotationPublisher?.clientId, "client-1")
    }

    @MainActor
    func testSuspendedOldHelloCannotAuthorizeReplacementRoute() async throws {
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
        let suspended = AnnotationSuspendedHelloTransport()
        let old = try XCTUnwrap(URL(string: "ws://127.0.0.1:29998/ws"))
        let selected = try XCTUnwrap(URL(string: "ws://127.0.0.1:29999/ws"))
        var endpoints: [URL] = []
        let publisher = try SurfAceAnnotationPublisher(
            adapter: adapter, endpoint: old,
            makeTransport: { endpoint in
                endpoints.append(endpoint)
                return endpoint == old ? suspended : AnnotationWireProbeTransport(probe)
            }, onError: { _ in }
        )
        var firstDrain: Task<Void, Error>!
        await withCheckedContinuation { entered in
            suspended.entered = entered
            firstDrain = Task { try await publisher.drain() }
        }
        try publisher.reconcileEndpoint(selected)
        suspended.response?.resume()
        suspended.response = nil
        do {
            try await firstDrain.value
            XCTFail("an old hello must not establish readiness on a replacement route")
        } catch {
            XCTAssertEqual((error as? URLError)?.code, .cancelled)
        }
        // Reconcile's serialized task may lose its first ingest response. Stop
        // its scheduled retry, then inspect the durable head before retrying.
        await publisher.awaitIdle()
        publisher.stop()
        var pending = try XCTUnwrap(store.load())
        XCTAssertEqual(try pending.annotationPublisher?.head(surfaceId: surfaceId)?.canonical, expected.canonical)
        let retryPublisher = try SurfAceAnnotationPublisher(
            adapter: adapter, endpoint: selected,
            makeTransport: { endpoint in endpoints.append(endpoint); return AnnotationWireProbeTransport(probe) },
            onError: { _ in }
        )
        try await retryPublisher.drain()
        retryPublisher.stop()
        XCTAssertEqual(endpoints, [old, selected, selected])
        XCTAssertEqual(probe.records, [expected.canonical, expected.canonical])
        let saved = try XCTUnwrap(store.load())
        XCTAssertEqual(saved.annotationPublisher?.pendingSurfaceIds(), [])
        XCTAssertEqual(saved.annotationPublisher?.clientId, "client-1")
        XCTAssertEqual(saved.annotationPublisher?.sourceEpoch, sourceEpoch)
    }
}
