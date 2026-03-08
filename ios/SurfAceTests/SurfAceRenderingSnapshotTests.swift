import Foundation
import Testing
@testable import Surf_Ace

@Suite(.serialized)
@MainActor
struct SurfAceRenderingSnapshotTests {
    @Test("WS-FRAME-01 + WS-SNAPSHOT-01: frame.set applies revision gate and snapshot defaults keep visibleText on, drawings off")
    func frameSetAndSnapshotDefaults() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            let frameID = makeFrameID()
            let frameSetPayload = makeHTMLFrame(frameID: frameID, html: "<html><body><p>Hello WS</p></body></html>")
                .merging(["revision": 1], uniquingKeysWith: { _, new in new })

            try await harness.sendRequest(client, op: "frame.set", id: "set_1", payload: frameSetPayload)
            let setResponse = try await harness.awaitResponse(client, id: "set_1")
            #expect(setResponse["ok"] as? Bool == true)
            #expect(((setResponse["payload"] as? [String: Any])?["currentRevision"] as? Int) == 1)

            try await harness.sendRequest(client, op: "snapshot.get", id: "snapshot_1", payload: [:])
            let snapshot = try await harness.awaitResponse(client, id: "snapshot_1")
            #expect(snapshot["ok"] as? Bool == true)

            let payload = snapshot["payload"] as? [String: Any]
            #expect(payload?["frameId"] as? String == frameID)
            #expect(payload?["visibleText"] as? String != nil)
            #expect(payload?["drawings"] == nil)
        }
    }

    @Test("WS-SNAPSHOT-03: visibleText excludes CSS/style declarations")
    func snapshotVisibleTextSkipsCSSNoise() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            let frameID = makeFrameID()
            let html = """
            <html><body>
              <style>p.p1 { margin: 0.0px; } span.s1 { font-family: Helvetica; }</style>
              <p class="p1"><span class="s1">Rendered Content</span></p>
            </body></html>
            """
            try await harness.sendRequest(
                client,
                op: "frame.set",
                id: "set_css_noise",
                payload: makeHTMLFrame(frameID: frameID, html: html).merging(["revision": 1], uniquingKeysWith: { _, new in new })
            )
            _ = try await harness.awaitResponse(client, id: "set_css_noise")

            try await harness.sendRequest(client, op: "snapshot.get", id: "snapshot_css_noise", payload: [:])
            let snapshot = try await harness.awaitResponse(client, id: "snapshot_css_noise")
            let payload = snapshot["payload"] as? [String: Any]
            let visibleText = payload?["visibleText"] as? String ?? ""

            #expect(visibleText.contains("Rendered Content"))
            #expect(visibleText.contains("p.p1") == false)
            #expect(visibleText.contains("span.s1") == false)
            #expect(visibleText.contains("font-family") == false)
        }
    }

    @Test("WS-SNAPSHOT-04: markdown visibleText uses source markdown (no CSS serializer noise)")
    func snapshotMarkdownVisibleTextUsesSource() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            let frameID = makeFrameID()
            let markdown = """
            ⚡ Build 11
            `code`
            """
            try await harness.sendRequest(
                client,
                op: "frame.set",
                id: "set_markdown_source",
                payload: makeMarkdownFrame(frameID: frameID, markdown: markdown).merging(["revision": 1], uniquingKeysWith: { _, new in new })
            )
            _ = try await harness.awaitResponse(client, id: "set_markdown_source")

            try await harness.sendRequest(client, op: "snapshot.get", id: "snapshot_markdown_source", payload: [:])
            let snapshot = try await harness.awaitResponse(client, id: "snapshot_markdown_source")
            let payload = snapshot["payload"] as? [String: Any]
            let visibleText = payload?["visibleText"] as? String ?? ""

            #expect(visibleText.contains("⚡ Build 11"))
            #expect(visibleText.contains("p.p1") == false)
            #expect(visibleText.contains("span.s1") == false)
            #expect(visibleText.contains("font-family") == false)
        }
    }

    @Test("WS-FRAME-02: stale revision returns expectedRevision")
    func staleRevisionError() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            let frameID = makeFrameID()
            try await harness.sendRequest(
                client,
                op: "frame.set",
                id: "set_ok",
                payload: makeMarkdownFrame(frameID: frameID, markdown: "one").merging(["revision": 1], uniquingKeysWith: { _, new in new })
            )
            _ = try await harness.awaitResponse(client, id: "set_ok")

            try await harness.sendRequest(
                client,
                op: "frame.set",
                id: "set_stale",
                payload: makeMarkdownFrame(frameID: makeFrameID(), markdown: "two").merging(["revision": 3], uniquingKeysWith: { _, new in new })
            )
            let stale = try await harness.awaitResponse(client, id: "set_stale")
            #expect(stale["ok"] as? Bool == false)
            #expect((stale["error"] as? [String: Any])?["code"] as? String == "stale_revision")
            let expected = ((stale["error"] as? [String: Any])?["details"] as? [String: Any])?["expectedRevision"] as? Int
            #expect(expected == 2)
        }
    }

    @Test("WS-FRAME-03 + WS-FRAME-04: append is terminal-only and patch is html-only")
    func appendAndPatchContentTypeRules() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            let htmlFrameID = makeFrameID()
            try await harness.sendRequest(
                client,
                op: "frame.set",
                id: "set_html",
                payload: makeHTMLFrame(frameID: htmlFrameID, html: "<div id='t'>html</div>").merging(["revision": 1], uniquingKeysWith: { _, new in new })
            )
            _ = try await harness.awaitResponse(client, id: "set_html")

            try await harness.sendRequest(
                client,
                op: "frame.append",
                id: "append_bad",
                payload: ["frameId": htmlFrameID, "revision": 2, "lines": ["tail"]]
            )
            let appendBad = try await harness.awaitResponse(client, id: "append_bad")
            #expect((appendBad["error"] as? [String: Any])?["code"] as? String == "unsupported_operation_for_content_type")

            let terminalFrameID = makeFrameID()
            try await harness.sendRequest(
                client,
                op: "frame.set",
                id: "set_terminal",
                payload: makeTerminalFrame(frameID: terminalFrameID, lines: ["line1"]).merging(["revision": 2], uniquingKeysWith: { _, new in new })
            )
            _ = try await harness.awaitResponse(client, id: "set_terminal")

            try await harness.sendRequest(
                client,
                op: "frame.patch",
                id: "patch_bad",
                payload: ["frameId": terminalFrameID, "revision": 3, "patch": ["selector": "#t", "action": "remove"]]
            )
            let patchBad = try await harness.awaitResponse(client, id: "patch_bad")
            #expect((patchBad["error"] as? [String: Any])?["code"] as? String == "unsupported_operation_for_content_type")
        }
    }

    @Test("WS-FRAME-05 + WS-SNAPSHOT-02: frame.clear clears frame and drawing overlay")
    func frameClearClearsFrameAndDrawings() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            let frameID = makeFrameID()
            try await harness.sendRequest(
                client,
                op: "frame.set",
                id: "set_for_clear",
                payload: makeMarkdownFrame(frameID: frameID, markdown: "clear me").merging(["revision": 1], uniquingKeysWith: { _, new in new })
            )
            _ = try await harness.awaitResponse(client, id: "set_for_clear")

            harness.runtime.handleNewStrokes([
                makeSampleStroke(strokeID: "stroke_clear_1")
            ])

            try await harness.sendRequest(
                client,
                op: "snapshot.get",
                id: "snapshot_with_drawings",
                payload: ["includeDrawings": true]
            )
            let beforeClearSnapshot = try await harness.awaitResponse(client, id: "snapshot_with_drawings")
            let beforeDrawings = ((beforeClearSnapshot["payload"] as? [String: Any])?["drawings"] as? [[String: Any]]) ?? []
            #expect(beforeDrawings.count == 1)

            try await harness.sendRequest(client, op: "frame.clear", id: "clear_1", payload: ["revision": 2])
            let clearResponse = try await harness.awaitResponse(client, id: "clear_1")
            #expect(clearResponse["ok"] as? Bool == true)
            #expect(((clearResponse["payload"] as? [String: Any])?["currentFrameId"] is NSNull) == true)

            try await harness.sendRequest(
                client,
                op: "snapshot.get",
                id: "snapshot_after_clear",
                payload: ["includeDrawings": true]
            )
            let afterClearSnapshot = try await harness.awaitResponse(client, id: "snapshot_after_clear")
            let afterPayload = afterClearSnapshot["payload"] as? [String: Any]
            #expect((afterPayload?["frameId"] is NSNull) == true)
            let afterDrawings = (afterPayload?["drawings"] as? [[String: Any]]) ?? []
            #expect(afterDrawings.isEmpty)
        }
    }

    @Test("WS-ANNOTATIONS-01: annotations.remove removes requested ids and is idempotent")
    func annotationsRemoveIdempotent() async throws {
        try await withHarness { harness in
            let client = harness.makeWSClient()
            client.connect()
            defer { client.close() }

            _ = try await harness.pair(client)

            let frameID = makeFrameID()
            try await harness.sendRequest(
                client,
                op: "frame.set",
                id: "set_for_annotations",
                payload: makeHTMLFrame(frameID: frameID, html: "<p>ink</p>").merging(["revision": 1], uniquingKeysWith: { _, new in new })
            )
            _ = try await harness.awaitResponse(client, id: "set_for_annotations")

            harness.runtime.handleNewStrokes([
                makeSampleStroke(strokeID: "stroke_one"),
                makeSampleStroke(strokeID: "stroke_two")
            ])

            try await harness.sendRequest(
                client,
                op: "annotations.remove",
                id: "remove_1",
                payload: ["frameId": frameID, "strokeIds": ["stroke_one", "stroke_missing"]]
            )
            let remove = try await harness.awaitResponse(client, id: "remove_1")
            #expect(remove["ok"] as? Bool == true)

            let removePayload = remove["payload"] as? [String: Any]
            let removed = removePayload?["removedStrokeIds"] as? [String]
            let missing = removePayload?["notFoundStrokeIds"] as? [String]
            #expect(removed == ["stroke_one"])
            #expect(missing == ["stroke_missing"])

            try await harness.sendRequest(
                client,
                op: "annotations.remove",
                id: "remove_2",
                payload: ["frameId": frameID, "strokeIds": ["stroke_one"]]
            )
            let removeAgain = try await harness.awaitResponse(client, id: "remove_2")
            let removeAgainPayload = removeAgain["payload"] as? [String: Any]
            #expect((removeAgainPayload?["removedStrokeIds"] as? [String])?.isEmpty == true)
            #expect(removeAgainPayload?["notFoundStrokeIds"] as? [String] == ["stroke_one"])
        }
    }
}
