import CoreGraphics
import Foundation
import Testing
@testable import Surf_Ace

@Suite(.serialized)
@MainActor
struct SurfAceWatchAndPencilTests {
    @Test("WS-EVENT-01: minimum_deep emits snapshot_hint, tap, and selection events")
    func minimumDeepEventStream() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            let frameID = makeFrameID()
            try await harness.sendRequest(
                client,
                op: "frame.set",
                id: "set_events",
                payload: makeHTMLFrame(frameID: frameID, html: "<p>events</p>").merging(["revision": 1], uniquingKeysWith: { _, new in new })
            )
            _ = try await harness.awaitResponse(client, id: "set_events")

            let snapshotHint = try await harness.awaitEvent(client, op: "event.snapshot_hint")
            #expect(snapshotHint["type"] as? String == "event")
            #expect(snapshotHint["op"] as? String == "event.snapshot_hint")
            #expect(((snapshotHint["payload"] as? [String: Any])?["reason"] as? String) == "after_render")

            harness.runtime.handleTapEvent(
                kind: "tap",
                position: SurfAcePoint(x: 120, y: 240),
                nearestContent: "events"
            )
            harness.runtime.handleSelectionChanged(
                text: "events",
                rect: CGRect(x: 10, y: 20, width: 50, height: 14)
            )

            let first = try await harness.awaitEvent(client)
            let second = try await harness.awaitEvent(client)
            let ops = Set([first["op"] as? String, second["op"] as? String].compactMap { $0 })
            #expect(ops.contains("event.tap"))
            #expect(ops.contains("event.selection"))
        }
    }

    @Test("WS-EVENT-02: deep_plus_scroll profile emits event.scroll")
    func deepPlusScrollEventProfile() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client, eventProfile: "deep_plus_scroll")

            let frameID = makeFrameID()
            try await harness.sendRequest(
                client,
                op: "frame.set",
                id: "set_scroll",
                payload: makeMarkdownFrame(frameID: frameID, markdown: "scroll").merging(["revision": 1], uniquingKeysWith: { _, new in new })
            )
            _ = try await harness.awaitResponse(client, id: "set_scroll")
            _ = try await harness.awaitEvent(client, op: "event.snapshot_hint")

            let viewport = SurfAceViewport(
                scrollOffset: SurfAcePoint(x: 0, y: 300),
                visibleRect: SurfAceRect(x: 0, y: 300, width: 1024, height: 768),
                contentSize: SurfAceSize(width: 1024, height: 3000),
                zoomLevel: 1
            )
            harness.runtime.handleScrollSettled(viewport: viewport, visibleText: "scroll visible")

            let event = try await harness.awaitEvent(client, op: "event.scroll")
            #expect(event["type"] as? String == "event")
            #expect(event["op"] as? String == "event.scroll")
            #expect(((event["payload"] as? [String: Any])?["visibleText"] as? String) == "scroll visible")
        }
    }

    @Test("WS-DRAW-01: drawing flush emits after idle window with stable stroke ids")
    func drawingFlushIdleGate() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(
                client,
                drawingFlushConfig: [
                    "idleWindowMs": 5000,
                    "maxIntervalMs": 10000
                ]
            )

            let frameID = makeFrameID()
            try await harness.sendRequest(
                client,
                op: "frame.set",
                id: "set_draw",
                payload: makeHTMLFrame(frameID: frameID, html: "<p>draw</p>").merging(["revision": 1], uniquingKeysWith: { _, new in new })
            )
            _ = try await harness.awaitResponse(client, id: "set_draw")
            _ = try await harness.awaitEvent(client, op: "event.snapshot_hint")

            harness.runtime.handleNewStrokes([
                makeSampleStroke(strokeID: "stroke_flush_1", startTimestamp: Int64(Date().timeIntervalSince1970 * 1000)),
                makeSampleStroke(strokeID: "stroke_flush_2", startTimestamp: Int64(Date().timeIntervalSince1970 * 1000) + 50)
            ])

            let flush = try await harness.awaitEvent(client, op: "event.drawing_flush", timeout: 7.0)
            #expect(flush["type"] as? String == "event")
            #expect(flush["op"] as? String == "event.drawing_flush")

            let payload = flush["payload"] as? [String: Any]
            #expect(payload?["frameId"] as? String == frameID)
            #expect((payload?["strokeCount"] as? Int) == 2)
            let strokes = payload?["strokes"] as? [[String: Any]]
            let ids = Set((strokes ?? []).compactMap { $0["strokeId"] as? String })
            #expect(ids.contains("stroke_flush_1"))
            #expect(ids.contains("stroke_flush_2"))
            #expect(harness.runtime.isDrawingFlushSending == false)
        }
    }

    @Test("WS-HEARTBEAT-01: heartbeat response is prioritized ahead of queued outbound events")
    func heartbeatPriority() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            let frameID = makeFrameID()
            try await harness.sendRequest(
                client,
                op: "frame.set",
                id: "set_heartbeat",
                payload: makeHTMLFrame(frameID: frameID, html: "<p>heartbeat</p>").merging(["revision": 1], uniquingKeysWith: { _, new in new })
            )
            _ = try await harness.awaitResponse(client, id: "set_heartbeat")
            _ = try await harness.awaitEvent(client, op: "event.snapshot_hint")

            for index in 0..<20 {
                harness.runtime.handleTapEvent(
                    kind: "tap",
                    position: SurfAcePoint(x: Double(index), y: Double(index)),
                    nearestContent: "burst"
                )
            }

            try await harness.sendRequest(
                client,
                op: "heartbeat.ping",
                id: "hb_1",
                payload: ["nonce": "n1"]
            )

            var eventsSeenBeforeHeartbeat = 0
            var heartbeat: [String: Any]?
            for _ in 0..<25 {
                let message = try await client.receiveJSON()
                if message["type"] as? String == "response", message["op"] as? String == "heartbeat.ping" {
                    heartbeat = message
                    break
                }
                if message["type"] as? String == "event" {
                    eventsSeenBeforeHeartbeat += 1
                }
            }

            #expect(heartbeat != nil)
            #expect(eventsSeenBeforeHeartbeat <= 6)
            #expect(((heartbeat?["payload"] as? [String: Any])?["nonce"] as? String) == "n1")
        }
    }

    @Test("WS-RECONNECT-01: reconnect within grace resumes and emits after_reconnect snapshot_hint")
    func reconnectGraceResume() async throws {
        try await withHarness { harness in
            let first = harness.makeWSClient()
            first.connect()

            let pairA = try await harness.pair(
                first,
                id: "pair_first",
                providerId: "pv_resume",
                connectionId: "cn_first"
            )
            let sessionId = (pairA["payload"] as? [String: Any])?["sessionId"] as? String
            #expect(sessionId != nil)

            first.close()

            try await Task.sleep(nanoseconds: 300_000_000)

            let second = harness.makeWSClient()
            second.connect()
            defer { second.close() }

            let pairB = try await harness.pair(
                second,
                id: "pair_second",
                providerId: "pv_resume",
                connectionId: "cn_second",
                takeover: true,
                resumeSessionId: sessionId
            )
            #expect(pairB["ok"] as? Bool == true)
            #expect(((pairB["payload"] as? [String: Any])?["resumed"] as? Bool) == true)

            let reconnectHint = try await harness.awaitEvent(second, op: "event.snapshot_hint")
            #expect(reconnectHint["op"] as? String == "event.snapshot_hint")
            #expect(((reconnectHint["payload"] as? [String: Any])?["reason"] as? String) == "after_reconnect")
        }
    }
}
