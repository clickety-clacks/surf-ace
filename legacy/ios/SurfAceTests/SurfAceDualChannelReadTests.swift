import Foundation
import Testing
@testable import Surf_Ace

@Suite(.serialized)
@MainActor
struct SurfAceDualChannelReadTests {
    @Test("DUAL-READ-01: same-context updates stay live and do not force frame finalization")
    func sameContextKeepsLiveFrameOpen() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)
            try await setHTMLContent(harness, client, contentId: "ct_11111111", revision: 1)

            harness.runtime.handleNewStrokes([
                makeSampleStroke(strokeID: "stroke_same_1", startTimestamp: 1_700_000_000_100)
            ])

            let first = try #require(harness.runtime.surfAceRead(fingerprint: harness.runtime.fingerprint))
            #expect(first.liveFrame != nil)
            #expect(first.frames.isEmpty)
            #expect(first.liveDirtyStrokeIds == ["stroke_same_1"])

            harness.runtime.handleNewStrokes([
                makeSampleStroke(strokeID: "stroke_same_2", startTimestamp: 1_700_000_000_200)
            ])

            let second = try #require(harness.runtime.surfAceRead(fingerprint: harness.runtime.fingerprint))
            #expect(second.frames.isEmpty)
            #expect(second.liveFrame?.frameId == first.liveFrame?.frameId)
            #expect(second.liveDirtyStrokeIds == ["stroke_same_2"])

            let third = try #require(harness.runtime.surfAceRead(fingerprint: harness.runtime.fingerprint))
            #expect(third.liveFrame?.frameId == first.liveFrame?.frameId)
            #expect(third.liveDirtyStrokeIds?.isEmpty == true)

            let baselineSeq = second.liveSeq
            #expect(harness.runtime.hasNewLiveData(since: baselineSeq) == false)
            harness.runtime.handleNewStrokes([
                makeSampleStroke(strokeID: "stroke_same_3", startTimestamp: 1_700_000_000_300)
            ])
            #expect(harness.runtime.hasNewLiveData(since: baselineSeq) == true)
        }
    }

    @Test("DUAL-READ-02: content.set finalizes current live frame into closed queue")
    func contentSetFinalizesOpenFrame() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)
            try await setHTMLContent(harness, client, contentId: "ct_22222222", revision: 1)
            harness.runtime.handleNewStrokes([
                makeSampleStroke(strokeID: "stroke_set_final", startTimestamp: 1_700_000_001_000)
            ])

            try await setHTMLContent(harness, client, contentId: "ct_33333333", revision: 2)

            let read = try #require(harness.runtime.surfAceRead(fingerprint: harness.runtime.fingerprint))
            #expect(read.liveFrame == nil)
            #expect(read.frames.count == 1)
            #expect(read.frames.first?.contentId == "ct_22222222")
            #expect(read.frames.first?.strokes.map(\.strokeId) == ["stroke_set_final"])

            let drained = try #require(harness.runtime.surfAceRead(fingerprint: harness.runtime.fingerprint))
            #expect(drained.frames.isEmpty)
        }
    }

    @Test("DUAL-READ-03: context switch by navigation finalizes prior context and opens new live context")
    func navigationContextSwitchFinalizesPreviousContext() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)
            try await setHTMLContent(harness, client, contentId: "ct_44444444", revision: 1)
            harness.runtime.handleNewStrokes([
                makeSampleStroke(strokeID: "stroke_nav_before", startTimestamp: 1_700_000_002_000)
            ])

            harness.runtime.handleNavigationEvent(url: "https://example.com/path?a=1#frag", sentAt: 1_700_000_002_500)
            harness.runtime.handleNewStrokes([
                makeSampleStroke(strokeID: "stroke_nav_after", startTimestamp: 1_700_000_003_000)
            ])

            let read = try #require(harness.runtime.surfAceRead(fingerprint: harness.runtime.fingerprint))
            #expect(read.liveFrame?.contextKey == "https://example.com/path?a=1")
            #expect(read.liveDirtyStrokeIds == ["stroke_nav_after"])
            #expect(read.frames.count == 1)
            #expect(read.frames.first?.contextKey == "ct_44444444")
            #expect(read.frames.first?.strokes.map(\.strokeId) == ["stroke_nav_before"])
            #expect(read.lastNavigation?.url == "https://example.com/path?a=1")
            #expect(read.lastNavigation?.navigatedAt == 1_700_000_002_500)
        }
    }

    @Test("DUAL-READ-03B: content.clear finalizes current live frame into closed queue")
    func contentClearFinalizesOpenFrame() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)
            try await setHTMLContent(harness, client, contentId: "ct_55555555", revision: 1)
            harness.runtime.handleNewStrokes([
                makeSampleStroke(strokeID: "stroke_clear_final", startTimestamp: 1_700_000_004_000)
            ])

            try await harness.sendRequest(
                client,
                op: "content.clear",
                id: "clear_1",
                payload: ["revision": 2]
            )
            _ = try await harness.awaitResponse(client, id: "clear_1")
            _ = try await harness.awaitEvent(client, op: "event.snapshot_hint")

            let read = try #require(harness.runtime.surfAceRead(fingerprint: harness.runtime.fingerprint))
            #expect(read.liveFrame == nil)
            #expect(read.frames.count == 1)
            #expect(read.frames.first?.contentId == "ct_55555555")
            #expect(read.frames.first?.strokes.map(\.strokeId) == ["stroke_clear_final"])
        }
    }

    @Test("DUAL-READ-04: closed queue is oldest-first and read is bounded to 5 frames")
    func closedQueueReadBatchBoundaries() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            try await setHTMLContent(harness, client, contentId: "ct_00000001", revision: 1)
            harness.runtime.handleNewStrokes([makeSampleStroke(strokeID: "stroke_batch_1", startTimestamp: 1_700_000_010_001)])

            for revision in 2...7 {
                let contentID = String(format: "ct_%08x", revision)
                try await setHTMLContent(harness, client, contentId: contentID, revision: revision)
                if revision <= 6 {
                    let strokeID = "stroke_batch_\(revision)"
                    let ts = Int64(1_700_000_010_000 + revision)
                    harness.runtime.handleNewStrokes([makeSampleStroke(strokeID: strokeID, startTimestamp: ts)])
                }
            }

            let firstRead = try #require(harness.runtime.surfAceRead(fingerprint: harness.runtime.fingerprint))
            #expect(firstRead.frames.count == 5)
            #expect(firstRead.frames.map(\.contentId) == [
                "ct_00000001",
                "ct_00000002",
                "ct_00000003",
                "ct_00000004",
                "ct_00000005"
            ])
            #expect(firstRead.pendingFrames == 1)

            let secondRead = try #require(harness.runtime.surfAceRead(fingerprint: harness.runtime.fingerprint))
            #expect(secondRead.frames.count == 1)
            #expect(secondRead.frames.first?.contentId == "ct_00000006")
            #expect(secondRead.pendingFrames == nil)
        }
    }

    private func setHTMLContent(
        _ harness: SurfAceTestHarness,
        _ client: SurfAceWSClient,
        contentId: String,
        revision: Int
    ) async throws {
        try await harness.sendRequest(
            client,
            op: "content.set",
            id: "set_\(contentId)_\(revision)",
            payload: [
                "contentId": contentId,
                "revision": revision,
                "contentType": "html",
                "content": ["html": "<p>\(contentId)</p>"]
            ]
        )
        _ = try await harness.awaitResponse(client, id: "set_\(contentId)_\(revision)")
        _ = try await harness.awaitEvent(client, op: "event.snapshot_hint")
    }
}
