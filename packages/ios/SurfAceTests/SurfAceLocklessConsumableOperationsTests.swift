import Foundation
import XCTest
@testable import SurfAce

final class SurfAceLocklessConsumableOperationsTests: XCTestCase {
    func testAppendUsesScopeFIFOAndExactVersionedDurableBytesAcrossCanonicalClasses() throws {
        var state = try authority(controllerIds: ["controller-a"])
        let classes: [SurfAceLocklessConsumableRecordClass] = [
            .content, .history, .topology, .annotationFrame, .targetResult,
            .tap, .scroll, .selection, .page, .playback, .navigation,
        ]
        var sequences: [Int64] = []
        for (index, recordClass) in classes.enumerated() {
            let occurrence = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
                in: &state,
                scopeId: "surface:surface-a",
                scopeKind: "surface",
                recordId: "record-\(index)",
                recordClass: recordClass,
                payload: .object(["index": .integer(Int64(index))])
            )
            XCTAssertTrue(occurrence.retained)
            XCTAssertEqual(occurrence.record.bytes, try exactBytes(occurrence.record))
            sequences.append(occurrence.record.sequence)
        }

        XCTAssertEqual(sequences, Array(1...Int64(classes.count)))
        let snapshot = try SurfAceLocklessConsumableOperations.snapshot(
            in: state,
            controllerInstanceId: "controller-a",
            scopeId: "surface:surface-a"
        )
        XCTAssertEqual(snapshot.firstRetainedSequence, 1)
        XCTAssertEqual(snapshot.lastRetainedSequence, Int64(classes.count))
        XCTAssertEqual(snapshot.version, 1)
        XCTAssertEqual(snapshot.records.map(\.sequence), sequences)
    }

    func testCapacityEvictionCreatesIndependentStickyGapsAndAcknowledgements() throws {
        var state = try authority(controllerIds: ["controller-a", "controller-b"])
        state.limits.maxPaneConsumableRecords = 2
        for index in 1...3 {
            _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
                in: &state,
                scopeId: "pane:surface-a:1",
                scopeKind: "pane",
                recordId: "tap-\(index)",
                recordClass: .tap,
                payload: .integer(Int64(index))
            )
        }

        let first = try snapshot(state, "controller-a")
        let second = try snapshot(state, "controller-b")
        XCTAssertEqual(first.records.map(\.sequence), [2, 3])
        XCTAssertEqual(first.cursor.cursor, 2)
        XCTAssertEqual(first.cursor.gap, second.cursor.gap)
        XCTAssertEqual(first.cursor.gap?.cause, "scope_capacity")
        XCTAssertEqual(first.cursor.gap?.firstLostSequence, 1)
        XCTAssertEqual(first.cursor.gap?.lastLostSequence, 1)
        XCTAssertEqual(first.cursor.gap?.droppedEventCount, 1)
        XCTAssertEqual(first.cursor.gap?.droppedFrameCount, 0)
        XCTAssertEqual(first.cursor.gap?.droppedRecordCount, 1)
        XCTAssertEqual(first.cursor.gap?.recordClasses, [.tap])
        XCTAssertEqual(first.cursor.gapGeneration, 1)

        _ = try SurfAceLocklessConsumableOperations.acknowledge(
            in: &state,
            controllerInstanceId: "controller-a",
            scopeId: "pane:surface-a:1",
            cursor: 4,
            gapGeneration: 1
        )
        XCTAssertNil(try snapshot(state, "controller-a").cursor.gap)
        XCTAssertNotNil(try snapshot(state, "controller-b").cursor.gap)
        XCTAssertEqual(try snapshot(state, "controller-b").records.map(\.sequence), [2, 3])

        _ = try SurfAceLocklessConsumableOperations.acknowledge(
            in: &state,
            controllerInstanceId: "controller-b",
            scopeId: "pane:surface-a:1",
            cursor: 4,
            gapGeneration: 1
        )
        XCTAssertEqual(try snapshot(state, "controller-a").records, [])
        XCTAssertEqual(try snapshot(state, "controller-b").records, [])
    }

    func testGapCoalescesExactRangeBytesCountsAndClassesWithSaturatingGeneration() throws {
        var state = try authority(controllerIds: ["controller-a"])
        state.limits.maxSurfaceConsumableRecords = 1
        let content = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state,
            scopeId: "surface:surface-a",
            scopeKind: "surface",
            recordId: "content",
            recordClass: .content,
            payload: .string("content")
        ).record
        let topology = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state,
            scopeId: "surface:surface-a",
            scopeKind: "surface",
            recordId: "topology",
            recordClass: .topology,
            payload: .string("topology")
        ).record
        _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state,
            scopeId: "surface:surface-a",
            scopeKind: "surface",
            recordId: "target",
            recordClass: .targetResult,
            payload: .string("target")
        )

        let gap = try SurfAceLocklessConsumableOperations.snapshot(
            in: state,
            controllerInstanceId: "controller-a",
            scopeId: "surface:surface-a"
        ).cursor.gap
        XCTAssertEqual(gap?.generation, 2)
        XCTAssertEqual(gap?.firstLostSequence, 1)
        XCTAssertEqual(gap?.lastLostSequence, 2)
        XCTAssertEqual(gap?.droppedBytes, content.bytes + topology.bytes)
        XCTAssertEqual(gap?.droppedEventCount, 2)
        XCTAssertEqual(gap?.droppedFrameCount, 0)
        XCTAssertEqual(gap?.droppedRecordCount, 2)
        XCTAssertEqual(gap?.recordClasses, [.content, .topology])
    }

    func testOversizeRecordConsumesSequenceAndPersistsStructuredLossWithoutPayload() throws {
        var state = try authority(controllerIds: ["controller-a"])
        state.limits.maxConsumableRecordBytes = 1
        let before = state
        let occurrence = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state,
            scopeId: "pane:surface-a:1",
            scopeKind: "pane",
            recordId: "oversize",
            recordClass: .content,
            payload: .string("payload")
        )
        XCTAssertFalse(occurrence.retained)
        XCTAssertNotEqual(state, before)
        XCTAssertEqual(state.scopes["pane:surface-a:1"]?.nextSequence, 2)
        XCTAssertEqual(state.scopes["pane:surface-a:1"]?.records, [])
        let gap = try snapshot(state, "controller-a").cursor.gap
        XCTAssertEqual(gap?.cause, "record_oversize")
        XCTAssertEqual(gap?.firstLostSequence, 1)
        XCTAssertEqual(gap?.lastLostSequence, 1)
        XCTAssertEqual(gap?.droppedBytes, occurrence.record.bytes)
        XCTAssertEqual(gap?.recordClasses, [.content])
    }

    func testExactScopeByteLimitEvictsWholeOldestRecordsAndThrownMutationIsAtomic() throws {
        var sizing = try authority(controllerIds: ["controller-a"])
        let sized = try append(&sizing, id: "record-1", recordClass: .tap).record

        var state = try authority(controllerIds: ["controller-a"])
        state.limits.maxPaneConsumableRecords = 10
        state.limits.maxPaneConsumableBytes = sized.bytes * 2
        _ = try append(&state, id: "record-1", recordClass: .tap)
        _ = try append(&state, id: "record-2", recordClass: .tap)
        let third = try append(&state, id: "record-3", recordClass: .tap)
        let current = try snapshot(state, "controller-a")
        XCTAssertTrue(third.retained)
        XCTAssertEqual(current.records.map(\.recordId), ["record-2", "record-3"])
        XCTAssertLessThanOrEqual(
            current.records.reduce(Int64(0)) { $0 + $1.bytes },
            state.limits.maxPaneConsumableBytes
        )
        XCTAssertEqual(current.cursor.gap?.droppedBytes, sized.bytes)

        let beforeFailure = state
        XCTAssertThrowsError(
            try SurfAceLocklessConsumableOperations.appendCommittedRecord(
                in: &state,
                scopeId: "pane:surface-a:1",
                scopeKind: "surface",
                recordId: "wrong-kind",
                recordClass: .content,
                payload: .null
            )
        )
        XCTAssertEqual(state, beforeFailure)
    }

    func testLatestWinsRegistersAndLiveAnnotationFramesRemainSequenceOrdered() throws {
        var state = try authority(controllerIds: ["controller-a"])
        _ = try append(&state, id: "scroll-1", recordClass: .scroll)
        _ = try append(&state, id: "tap-1", recordClass: .tap)
        _ = try append(&state, id: "scroll-2", recordClass: .scroll)
        let live = try SurfAceLocklessConsumableOperations.updateLiveFrame(
            in: &state,
            scopeId: "pane:surface-a:1",
            frameId: "frame-a",
            payload: .string("first")
        )
        let replaced = try SurfAceLocklessConsumableOperations.updateLiveFrame(
            in: &state,
            scopeId: "pane:surface-a:1",
            frameId: "frame-a",
            payload: .string("latest")
        )
        XCTAssertTrue(live.retained)
        XCTAssertTrue(replaced.retained)

        var current = try snapshot(state, "controller-a")
        XCTAssertEqual(current.records.map(\.recordId), ["tap-1", "scroll-2", "frame-a"])
        XCTAssertEqual(current.records.map(\.sequence), [2, 3, 5])
        XCTAssertEqual(current.records.last?.payload, .string("latest"))

        let finalized = try SurfAceLocklessConsumableOperations.finalizeLiveFrame(
            in: &state,
            scopeId: "pane:surface-a:1",
            frameId: "frame-a",
            recordId: "closed-frame"
        )
        XCTAssertTrue(finalized?.retained == true)
        current = try snapshot(state, "controller-a")
        XCTAssertEqual(current.records.map(\.recordId), ["tap-1", "scroll-2", "closed-frame"])
        XCTAssertEqual(current.records.map(\.sequence), [2, 3, 6])
        XCTAssertEqual(current.lastRetainedSequence, 6)
    }

    func testDeltaIsControllerLocalAndAdmissionStartsAtCurrentTail() throws {
        var state = try authority(controllerIds: ["controller-a"])
        _ = try append(&state, id: "tap-1", recordClass: .tap)
        _ = try append(&state, id: "tap-2", recordClass: .tap)
        _ = try SurfAceLocklessConsumableOperations.acknowledge(
            in: &state,
            controllerInstanceId: "controller-a",
            scopeId: "pane:surface-a:1",
            cursor: 2,
            gapGeneration: nil
        )
        state.controllers["controller-b"] = controller("controller-b")
        SurfAceLocklessConsumableOperations.admitController("controller-b", in: &state)

        let firstDelta = try SurfAceLocklessConsumableOperations.delta(
            in: state,
            controllerInstanceId: "controller-a",
            scopeId: "pane:surface-a:1"
        )
        let secondDelta = try SurfAceLocklessConsumableOperations.delta(
            in: state,
            controllerInstanceId: "controller-b",
            scopeId: "pane:surface-a:1"
        )
        XCTAssertEqual(firstDelta.records.map(\.sequence), [2])
        XCTAssertEqual(secondDelta.records, [])
        XCTAssertEqual(secondDelta.lastRetainedSequence, 2)
        XCTAssertEqual(
            state.scopes["pane:surface-a:1"]?.cursors["controller-b"]?.cursor,
            3
        )
    }

    private func append(
        _ state: inout SurfAceLocklessAuthorityState,
        id: String,
        recordClass: SurfAceLocklessConsumableRecordClass
    ) throws -> SurfAceLocklessConsumableOccurrence {
        try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state,
            scopeId: "pane:surface-a:1",
            scopeKind: "pane",
            recordId: id,
            recordClass: recordClass,
            payload: .string(id)
        )
    }

    private func snapshot(
        _ state: SurfAceLocklessAuthorityState,
        _ controllerId: String
    ) throws -> SurfAceLocklessConsumableScopeSnapshot {
        try SurfAceLocklessConsumableOperations.snapshot(
            in: state,
            controllerInstanceId: controllerId,
            scopeId: "pane:surface-a:1"
        )
    }

    private func authority(controllerIds: [String]) throws -> SurfAceLocklessAuthorityState {
        var state = try SurfAceLocklessAuthorityState.empty()
        state.controllers = Dictionary(uniqueKeysWithValues: controllerIds.map { ($0, controller($0)) })
        return state
    }

    private func controller(_ id: String) -> SurfAceLocklessControllerBundle {
        SurfAceLocklessControllerBundle(
            controllerInstanceId: id,
            controllerProductName: "test",
            disconnectedAt: nil,
            dormantSequence: nil,
            pendingOperationReceipts: [:],
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            status: .live
        )
    }

    private func exactBytes(_ record: SurfAceLocklessConsumableRecord) throws -> Int64 {
        let value: SurfAceLocklessJSON = .object([
            "payload": record.payload,
            "recordClass": .string(record.recordClass.rawValue),
            "recordId": .string(record.recordId),
            "sequence": .integer(record.sequence),
            "version": .integer(1),
        ])
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return Int64(try encoder.encode(value).count)
    }
}

extension SurfAceLocklessConsumableOperationsTests {
    func testACLIVEBUF01ConnectedNeverReaderGetsTargetedStickyGapWhileProducerContinues() throws {
        var state = try authority(controllerIds: ["slow-a", "producer-b"])
        state.limits.maxPaneConsumableRecords = 2
        var droppedSequences: [Int64] = []
        for index in 1...5 {
            let occurrence = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
                in: &state, scopeId: "pane:surface-a:1", scopeKind: "pane",
                recordId: "tap-\(index)", recordClass: .tap, payload: .integer(Int64(index))
            )
            if !occurrence.affectedGaps.isEmpty {
                droppedSequences.append(Int64(index - 2))
            }
            _ = try SurfAceLocklessConsumableOperations.acknowledge(
                in: &state, controllerInstanceId: "producer-b", scopeId: "pane:surface-a:1",
                cursor: occurrence.record.sequence + 1, gapGeneration: nil
            )
        }
        let slow = try snapshot(state, "slow-a")
        let producer = try snapshot(state, "producer-b")
        XCTAssertEqual(droppedSequences, [1, 2, 3])
        XCTAssertEqual(slow.cursor.gap?.firstLostSequence, 1)
        XCTAssertEqual(slow.cursor.gap?.lastLostSequence, 3)
        XCTAssertEqual(slow.cursor.gap?.droppedRecordCount, 3)
        XCTAssertNil(producer.cursor.gap)
        XCTAssertLessThanOrEqual(slow.records.count, 2)
        XCTAssertEqual(slow.records.map(\.sequence), [4, 5])
    }

    func testACLIVEBUF02DeclaredCoalescingTargetResultsOversizeReplayAndAckStayDistinct() throws {
        var state = try authority(controllerIds: ["a"])
        _ = try append(&state, id: "scroll-old", recordClass: .scroll)
        _ = try append(&state, id: "tap", recordClass: .tap)
        _ = try append(&state, id: "scroll-latest", recordClass: .scroll)
        _ = try SurfAceLocklessConsumableOperations.updateLiveFrame(
            in: &state, scopeId: "pane:surface-a:1", frameId: "live", payload: .string("one")
        )
        _ = try SurfAceLocklessConsumableOperations.updateLiveFrame(
            in: &state, scopeId: "pane:surface-a:1", frameId: "live", payload: .string("two")
        )
        _ = try SurfAceLocklessConsumableOperations.appendCommittedRecord(
            in: &state, scopeId: "surface:surface-a", scopeKind: "surface",
            recordId: "target-result", recordClass: .targetResult,
            payload: .object(["status": .string("applied")])
        )
        let surfaceSnapshot = try SurfAceLocklessConsumableOperations.snapshot(
            in: state, controllerInstanceId: "a", scopeId: "surface:surface-a"
        )
        XCTAssertEqual(surfaceSnapshot.records.map(\.recordClass), [.targetResult])
        XCTAssertEqual(try snapshot(state, "a").records.map(\.recordId), ["tap", "scroll-latest", "live"])

        state.limits.maxConsumableRecordBytes = 1
        let oversize = try append(&state, id: "oversize", recordClass: .content)
        XCTAssertFalse(oversize.retained)
        let delta = try SurfAceLocklessConsumableOperations.delta(
            in: state, controllerInstanceId: "a", scopeId: "pane:surface-a:1"
        )
        let loss = try snapshot(state, "a").cursor
        XCTAssertEqual(loss.gap?.cause, "record_oversize")
        XCTAssertEqual(loss.gap?.recordClasses, [.content])
        _ = try SurfAceLocklessConsumableOperations.acknowledge(
            in: &state, controllerInstanceId: "a", scopeId: "pane:surface-a:1",
            cursor: delta.lastRetainedSequence + 1, gapGeneration: loss.gapGeneration
        )
        XCTAssertNil(try snapshot(state, "a").cursor.gap)
    }

    func testACREAD02WithinWindowCatchesUpAndCrossingWindowUsesStructuredLoss() throws {
        var state = try authority(controllerIds: ["slow", "producer"])
        state.limits.maxPaneConsumableRecords = 3
        _ = try append(&state, id: "one", recordClass: .content)
        _ = try append(&state, id: "two", recordClass: .content)
        XCTAssertEqual(try snapshot(state, "slow").records.map(\.recordId), ["one", "two"])
        XCTAssertNil(try snapshot(state, "slow").cursor.gap)
        _ = try SurfAceLocklessConsumableOperations.acknowledge(
            in: &state, controllerInstanceId: "producer", scopeId: "pane:surface-a:1",
            cursor: 3, gapGeneration: nil
        )
        _ = try append(&state, id: "three", recordClass: .content)
        _ = try append(&state, id: "four", recordClass: .content)
        let crossed = try snapshot(state, "slow")
        XCTAssertEqual(crossed.records.map(\.recordId), ["two", "three", "four"])
        XCTAssertEqual(crossed.cursor.gap?.cause, "scope_capacity")
        XCTAssertEqual(crossed.cursor.gap?.firstLostSequence, 1)
        XCTAssertNil(try snapshot(state, "producer").cursor.gap)
    }
}
