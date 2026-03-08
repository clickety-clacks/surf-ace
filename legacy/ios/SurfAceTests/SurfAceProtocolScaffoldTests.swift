import Foundation
import Testing
@testable import Surf_Ace

@Suite(.serialized)
@MainActor
struct SurfAceProtocolScaffoldTests {
    @Test("WS-SCAFFOLD-01: surfaces.list responds pre-pair with one surfaced window descriptor")
    func surfacesListBeforePair() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            try await client.send([
                "v": 1,
                "type": "request",
                "op": "surfaces.list",
                "id": "list_1"
            ])

            let response = try await harness.awaitResponse(client, id: "list_1")
            #expect(response["ok"] as? Bool == true)
            #expect(response["op"] as? String == "surfaces.list")

            let surfaces = ((response["payload"] as? [String: Any])?["surfaces"] as? [[String: Any]]) ?? []
            #expect(surfaces.count == 1)
            #expect((surfaces.first?["surfaceId"] as? String)?.hasPrefix("sf_") == true)
        }
    }

    @Test("WS-SCAFFOLD-02: content.set is pair-first and accepts ct_* content IDs")
    func contentOperationsPairFirstAndMapped() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            try await harness.sendRequest(
                client,
                op: "content.set",
                id: "content_before_pair",
                payload: [
                    "contentId": "ct_before01",
                    "revision": 1,
                    "contentType": "html",
                    "content": ["html": "<p>before pair</p>"]
                ]
            )
            let beforePair = try await harness.awaitResponse(client, id: "content_before_pair")
            #expect(beforePair["ok"] as? Bool == false)
            #expect((beforePair["error"] as? [String: Any])?["code"] as? String == "not_paired")

            _ = try await harness.pair(client)

            try await harness.sendRequest(
                client,
                op: "content.set",
                id: "content_after_pair",
                payload: [
                    "contentId": "ct_1a2b3c4d",
                    "revision": 1,
                    "contentType": "html",
                    "content": ["html": "<p>mapped</p>"]
                ]
            )
            let setResponse = try await harness.awaitResponse(client, id: "content_after_pair")
            #expect(setResponse["ok"] as? Bool == true)
            #expect(setResponse["op"] as? String == "content.set")
            let payload = setResponse["payload"] as? [String: Any]
            #expect(payload?["currentContentId"] as? String == "ct_1a2b3c4d")
        }
    }

    @Test("WS-SCAFFOLD-03: content.clear acknowledges with content-state fields")
    func contentClearAckShape() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            try await harness.sendRequest(
                client,
                op: "content.set",
                id: "content_set_for_clear",
                payload: [
                    "contentId": "ct_abcd1234",
                    "revision": 1,
                    "contentType": "html",
                    "content": ["html": "<p>to clear</p>"]
                ]
            )
            _ = try await harness.awaitResponse(client, id: "content_set_for_clear")
            _ = try await harness.awaitEvent(client, op: "event.snapshot_hint")

            try await harness.sendRequest(
                client,
                op: "content.clear",
                id: "content_clear",
                payload: ["revision": 2]
            )
            let clearResponse = try await harness.awaitResponse(client, id: "content_clear")
            #expect(clearResponse["ok"] as? Bool == true)
            #expect(clearResponse["op"] as? String == "content.clear")
            let payload = clearResponse["payload"] as? [String: Any]
            #expect((payload?["currentContentId"] is NSNull) == true)
            #expect((payload?["currentRevision"] as? Int) == 2)
        }
    }

    @Test("WS-SCAFFOLD-04: stale content rewrite returns stale_content for content.append")
    func contentAppendStaleContentCode() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            try await harness.sendRequest(
                client,
                op: "content.set",
                id: "content_set_for_stale",
                payload: [
                    "contentId": "ct_11223344",
                    "revision": 1,
                    "contentType": "terminal",
                    "content": [
                        "lines": ["a"],
                        "scrollback": 1000
                    ]
                ]
            )
            _ = try await harness.awaitResponse(client, id: "content_set_for_stale")
            _ = try await harness.awaitEvent(client, op: "event.snapshot_hint")

            try await harness.sendRequest(
                client,
                op: "content.append",
                id: "content_append_stale",
                payload: [
                    "contentId": "ct_deadbeef",
                    "revision": 2,
                    "lines": ["b"]
                ]
            )
            let staleResponse = try await harness.awaitResponse(client, id: "content_append_stale")
            #expect(staleResponse["ok"] as? Bool == false)
            #expect((staleResponse["error"] as? [String: Any])?["code"] as? String == "stale_content")
        }
    }

    @Test("WS-SCAFFOLD-05: annotations.remove accepts contentId selector")
    func annotationsRemoveWithContentId() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            try await harness.sendRequest(
                client,
                op: "content.set",
                id: "content_set_for_annotations",
                payload: [
                    "contentId": "ct_55667788",
                    "revision": 1,
                    "contentType": "html",
                    "content": ["html": "<p>annotate</p>"]
                ]
            )
            _ = try await harness.awaitResponse(client, id: "content_set_for_annotations")
            _ = try await harness.awaitEvent(client, op: "event.snapshot_hint")

            harness.runtime.handleNewStrokes([
                makeSampleStroke(strokeID: "stroke_remove_1", startTimestamp: Int64(Date().timeIntervalSince1970 * 1000))
            ])

            try await harness.sendRequest(
                client,
                op: "annotations.remove",
                id: "annotations_remove_content_id",
                payload: [
                    "contentId": "ct_55667788",
                    "strokeIds": ["stroke_remove_1"]
                ]
            )
            let response = try await harness.awaitResponse(client, id: "annotations_remove_content_id")
            #expect(response["ok"] as? Bool == true)
            let payload = response["payload"] as? [String: Any]
            #expect(payload?["contentId"] as? String == "ct_55667788")
            #expect((payload?["removedStrokeIds"] as? [String])?.contains("stroke_remove_1") == true)
        }
    }

    @Test("WS-SCAFFOLD-06: snapshot.get omits visibleText when includeVisibleText is false")
    func snapshotVisibleTextOmittedWhenDisabled() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            try await harness.sendRequest(
                client,
                op: "content.set",
                id: "content_set_for_snapshot_flags",
                payload: [
                    "contentId": "ct_99aabbcc",
                    "revision": 1,
                    "contentType": "markdown",
                    "content": ["markdown": "hello"]
                ]
            )
            _ = try await harness.awaitResponse(client, id: "content_set_for_snapshot_flags")
            _ = try await harness.awaitEvent(client, op: "event.snapshot_hint")

            try await harness.sendRequest(
                client,
                op: "snapshot.get",
                id: "snapshot_no_visible_text",
                payload: [
                    "includeVisibleText": false
                ]
            )
            let snapshot = try await harness.awaitResponse(client, id: "snapshot_no_visible_text")
            let payload = snapshot["payload"] as? [String: Any] ?? [:]
            #expect(payload["visibleText"] == nil)
            #expect(payload["contentId"] as? String == "ct_99aabbcc")
        }
    }
}
