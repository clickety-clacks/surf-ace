import Foundation
import Testing
@testable import Surf_Ace

@Suite(.serialized)
@MainActor
struct SurfAceHTTPPairingEdgeTests {
    @Test("WS-TRANSPORT-01: health endpoint is available and reports busy state")
    func healthEndpointReportsState() async throws {
        try await withHarness { harness in
            let before = try await harness.health()
            #expect(before.statusCode == 200)
            let beforeBody = try before.jsonDictionary()
            #expect(beforeBody["status"] as? String == "ok")
            #expect(beforeBody["busy"] as? Bool == false)

            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }
            let pair = try await harness.pair(client)
            #expect(pair["ok"] as? Bool == true)

            let after = try await harness.health()
            let afterBody = try after.jsonDictionary()
            #expect(afterBody["busy"] as? Bool == true)
        }
    }

    @Test("WS-PAIR-01: pair.request returns session metadata and limits")
    func pairResponseShape() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            let response = try await harness.pair(client)
            #expect(response["type"] as? String == "response")
            #expect(response["op"] as? String == "pair.request")
            #expect(response["ok"] as? Bool == true)

            let payload = response["payload"] as? [String: Any]
            #expect(payload != nil)
            #expect((payload?["sessionId"] as? String)?.hasPrefix("sa_") == true)
            #expect(payload?["resumed"] as? Bool == false)
            #expect((payload?["limits"] as? [String: Any])?["maxMessageBytes"] as? Int == 12 * 1024 * 1024)
            #expect((payload?["eventConfig"] as? [String: Any])?["profile"] as? String == "minimum_deep")
            #expect((payload?["state"] as? [String: Any])?["currentRevision"] as? Int == 0)
        }
    }

    @Test("WS-PAIR-02: pair-first rule rejects frame operations before pairing")
    func pairFirstRule() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            try await harness.sendRequest(
                client,
                op: "frame.set",
                id: "req_1",
                payload: makeHTMLFrame(frameID: makeFrameID(), html: "<p>x</p>").merging(["revision": 1], uniquingKeysWith: { _, new in new })
            )

            let response = try await harness.awaitResponse(client, id: "req_1")
            #expect(response["ok"] as? Bool == false)
            let error = response["error"] as? [String: Any]
            #expect(error?["code"] as? String == "not_paired")
        }
    }

    @Test("WS-PAIR-03: occupied surface rejects other provider and accepts same-provider takeover")
    func busyAndTakeover() async throws {
        try await withHarness { harness in
            let first = harness.makeWSClient()
            first.connect()
            defer { first.close() }

            let pairA = try await harness.pair(
                first,
                id: "pair_a",
                providerId: "pv_provider_a",
                connectionId: "cn_a"
            )
            let sessionA = (pairA["payload"] as? [String: Any])?["sessionId"] as? String
            #expect(sessionA != nil)

            let second = harness.makeWSClient()
            second.connect()
            defer { second.close() }

            let busy = try await harness.pair(
                second,
                id: "pair_b",
                providerId: "pv_provider_b",
                connectionId: "cn_b"
            )
            #expect(busy["ok"] as? Bool == false)
            #expect((busy["error"] as? [String: Any])?["code"] as? String == "busy")

            let takeover = harness.makeWSClient()
            takeover.connect()
            defer { takeover.close() }

            let resumed = try await harness.pair(
                takeover,
                id: "pair_c",
                providerId: "pv_provider_a",
                connectionId: "cn_c",
                takeover: true
            )
            #expect(resumed["ok"] as? Bool == true)
            let resumedPayload = resumed["payload"] as? [String: Any]
            #expect(resumedPayload?["resumed"] as? Bool == true)
            #expect(resumedPayload?["sessionId"] as? String == sessionA)
        }
    }

    @Test("WS-PAIR-04: duplicate request id replays same payload and rejects id reuse with different payload")
    func requestIdIdempotencyRules() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            let frameID = makeFrameID()
            let payload: [String: Any] = makeMarkdownFrame(frameID: frameID, markdown: "hello")
                .merging(["revision": 1], uniquingKeysWith: { _, new in new })

            try await harness.sendRequest(client, op: "frame.set", id: "dup_req", payload: payload)
            let first = try await harness.awaitResponse(client, id: "dup_req")

            try await harness.sendRequest(client, op: "frame.set", id: "dup_req", payload: payload)
            let replay = try await harness.awaitResponse(client, id: "dup_req")

            #expect(first["ok"] as? Bool == true)
            #expect(replay["ok"] as? Bool == true)
            #expect((first["payload"] as? [String: Any])?["currentRevision"] as? Int == 1)
            #expect((replay["payload"] as? [String: Any])?["currentRevision"] as? Int == 1)

            let differentPayload: [String: Any] = makeMarkdownFrame(frameID: makeFrameID(), markdown: "different")
                .merging(["revision": 2], uniquingKeysWith: { _, new in new })
            try await harness.sendRequest(client, op: "frame.set", id: "dup_req", payload: differentPayload)
            let mismatch = try await harness.awaitResponse(client, id: "dup_req")
            #expect(mismatch["ok"] as? Bool == false)
            #expect((mismatch["error"] as? [String: Any])?["code"] as? String == "invalid_request_id_reuse")
        }
    }

    @Test("WS-PAIR-05: unsupported protocol version is rejected")
    func unsupportedProtocolVersion() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            try await harness.sendRequest(
                client,
                op: "pair.request",
                id: "pair_bad_version",
                payload: [
                    "providerId": "pv_provider",
                    "connectionId": "cn_provider",
                    "protocolVersion": 2
                ]
            )

            let response = try await harness.awaitResponse(client, id: "pair_bad_version")
            #expect(response["ok"] as? Bool == false)
            #expect((response["error"] as? [String: Any])?["code"] as? String == "unsupported_protocol_version")
        }
    }
}
