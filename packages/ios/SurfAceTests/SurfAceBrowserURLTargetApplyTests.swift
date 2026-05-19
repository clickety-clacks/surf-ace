import Foundation
import XCTest
@testable import SurfAce

@MainActor
final class SurfAceBrowserURLTargetApplyTests: XCTestCase {
    func testIOSAdvertisesLiveBrowserURLTargetCapability() {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())

        XCTAssertEqual(runtime.targetCapabilitiesForTesting(), ["target.browser_url.v1"])
    }

    func testBrowserURLTargetApplyWaitsForNavigationEvidenceBeforeReturningApplied() async throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "browser-url-success")
        let pane = try XCTUnwrap(surface.panes.first)
        let bridge = ControlledPaneBridge(
            result: SurfAceBrowserNavigationResult(errorMessage: nil, status: "applied", url: "https://google.com/"),
            renderDelayNanoseconds: 100_000_000
        )
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)

        let startedAt = Date()
        let response = await runtime.materializeTargetApplyForTesting(
            id: "rq_google",
            payload: targetApplyPayload(surface: surface, pane: pane, targetId: "tg_google", url: "https://google.com/"),
            surfaceId: surface.surfaceId
        )
        let payload = try XCTUnwrap(response["payload"] as? [String: Any])
        let materializedState = try XCTUnwrap(payload["materializedState"] as? [String: Any])

        XCTAssertGreaterThanOrEqual(Date().timeIntervalSince(startedAt), 0.08)
        XCTAssertEqual(bridge.renderedBrowserURLEntries.map(\.url), ["https://google.com/"])
        XCTAssertEqual(bridge.renderedBrowserURLEntries.map(\.title), [nil])
        XCTAssertEqual(response["op"] as? String, "target.apply.result")
        XCTAssertEqual(payload["status"] as? String, "applied")
        XCTAssertNil(payload["errorCode"])
        XCTAssertEqual(materializedState["navigationStatus"] as? String, "loaded")
        XCTAssertEqual(materializedState["replaySemantics"] as? String, "navigate")
        XCTAssertEqual(surface.panes.first?.currentEntry.contentId, nil)
        XCTAssertEqual(surface.panes.first?.currentEntry.contentType, nil)
        XCTAssertEqual(surface.panes.first?.currentTarget?.lastApplyEvidence?["status"] as? String, "applied")
    }

    func testBrowserURLTargetApplyPreservesDisplayTitleForChrome() async throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "browser-url-display")
        let pane = try XCTUnwrap(surface.panes.first)
        let bridge = ControlledPaneBridge(
            result: SurfAceBrowserNavigationResult(errorMessage: nil, status: "applied", url: "https://example.com/")
        )
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)

        var payload = targetApplyPayload(surface: surface, pane: pane, targetId: "tg_display", url: "https://example.com/")
        payload["display"] = [
            "title": "Browser Pusher",
            "provenance": [
                "displayName": "Browser Pusher",
                "sessionKey": "agent:test:browser",
            ],
        ]

        _ = await runtime.materializeTargetApplyForTesting(
            id: "rq_display",
            payload: payload,
            surfaceId: surface.surfaceId
        )

        XCTAssertEqual(bridge.renderedBrowserURLEntries.map(\.title), ["Browser Pusher"])
        XCTAssertEqual(surface.panes.first?.currentEntry.provenanceSessionKey, "agent:test:browser")
        XCTAssertEqual(surface.panes.first?.currentOwnerDisplayName(), "Browser Pusher")
        XCTAssertEqual(surface.panes.first?.currentProvenanceDisplayName(), "Browser Pusher")
        XCTAssertEqual(surface.panes.first?.currentChromeDisplayName(), "Browser Pusher")
    }

    func testBrowserURLTargetApplyRecordsFailedNavigationEvidence() async throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "browser-url-failure")
        let pane = try XCTUnwrap(surface.panes.first)
        let bridge = ControlledPaneBridge(
            result: SurfAceBrowserNavigationResult(errorMessage: "Blocked", status: "failed", url: "https://blocked.invalid/")
        )
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)

        let response = await runtime.materializeTargetApplyForTesting(
            id: "rq_blocked",
            payload: targetApplyPayload(surface: surface, pane: pane, targetId: "tg_blocked", url: "https://blocked.invalid/"),
            surfaceId: surface.surfaceId
        )
        let payload = try XCTUnwrap(response["payload"] as? [String: Any])
        let materializedState = try XCTUnwrap(payload["materializedState"] as? [String: Any])

        XCTAssertEqual(response["op"] as? String, "target.apply.result")
        XCTAssertEqual(payload["status"] as? String, "failed")
        XCTAssertEqual(payload["errorCode"] as? String, "materialization_failed")
        XCTAssertEqual(payload["message"] as? String, "Blocked")
        XCTAssertEqual(materializedState["navigationStatus"] as? String, "failed")
        XCTAssertEqual(materializedState["url"] as? String, "https://blocked.invalid/")
        XCTAssertEqual(surface.panes.first?.currentTarget?.lastApplyEvidence?["status"] as? String, "failed")
    }

    func testBrowserURLTargetApplyRejectsUnsafeSchemesWithoutBridgeMaterialization() async throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "browser-url-unsafe")
        let pane = try XCTUnwrap(surface.panes.first)
        let bridge = ControlledPaneBridge()
        runtime.attachPaneBridge(surfaceId: surface.surfaceId, paneId: pane.paneId, bridge: bridge)

        let response = await runtime.materializeTargetApplyForTesting(
            id: "rq_file",
            payload: targetApplyPayload(surface: surface, pane: pane, targetId: "tg_file", url: "file:///etc/passwd"),
            surfaceId: surface.surfaceId
        )
        let payload = try XCTUnwrap(response["payload"] as? [String: Any])

        XCTAssertEqual(response["op"] as? String, "target.apply.result")
        XCTAssertEqual(payload["status"] as? String, "rejected")
        XCTAssertEqual(payload["errorCode"] as? String, "unsafe_payload")
        XCTAssertTrue(bridge.renderedBrowserURLEntries.isEmpty)
        XCTAssertNil(surface.panes.first?.currentTarget)
    }

    func testHTMLNavigationEventIsRejectedWhileAnnotationModeIsActive() throws {
        let runtime = SurfAceRuntime(userDefaults: isolatedUserDefaults())
        let surface = runtime.registerSurface(sceneKey: "html-navigation-annotating")
        let pane = try XCTUnwrap(surface.panes.first)
        pane.currentEntry = SurfAcePaneEntry(
            contentId: "ct_12345678",
            revision: 4,
            historyOwnerToken: "hot_html",
            contentType: .html,
            payload: .html(html: "<a href=\"https://example.com/next\">next</a>", baseURL: nil),
            reloadSource: nil,
            title: "HTML",
            scrollable: true,
            interactive: true,
            url: nil,
            drawingData: Data(),
            strokesById: [:]
        )
        pane.annotationMode = true

        runtime.handleNavigationEvent(
            surfaceId: surface.surfaceId,
            paneId: pane.paneId,
            url: "https://example.com/next#section",
            sentAt: nil
        )

        XCTAssertEqual(pane.currentEntry.contentType, .html)
        XCTAssertEqual(pane.currentEntry.contentId, "ct_12345678")
        XCTAssertTrue(pane.backStack.isEmpty)
        XCTAssertEqual(pane.toast, "Finish annotation (Done) to navigate")
    }

    private func isolatedUserDefaults() -> UserDefaults {
        let suiteName = "SurfAceBrowserURLTargetApplyTests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suiteName)!
        defaults.removePersistentDomain(forName: suiteName)
        return defaults
    }

    private func targetApplyPayload(
        surface: SurfAceSurfaceModel,
        pane: SurfAcePaneModel,
        targetId: String,
        url: String
    ) -> [String: Any] {
        [
            "requestId": "tr_\(targetId)",
            "targetId": targetId,
            "surfaceId": surface.surfaceId,
            "ownershipSessionId": "sa_test",
            "ownershipEpoch": 1,
            "paneLineageId": pane.paneLineageId,
            "targetEpoch": 2,
            "targetKind": "browser_url",
            "targetHeader": [
                "summary": url,
                "requiredCapabilities": ["target.browser_url.v1"],
                "safetyClass": "network",
                "replaySemantics": "navigate",
                "payloadSchemaVersion": 1,
                "safeToLogFields": ["url"],
            ],
            "targetPayload": ["url": url],
            "restoreReason": "initial_apply",
        ]
    }
}

@MainActor
private final class ControlledPaneBridge: SurfAcePaneBridging {
    var renderedBrowserURLEntries: [SurfAcePaneEntry] = []
    private let renderDelayNanoseconds: UInt64
    private let result: SurfAceBrowserNavigationResult

    init(
        result: SurfAceBrowserNavigationResult = SurfAceBrowserNavigationResult(
            errorMessage: nil,
            status: "applied",
            url: ""
        ),
        renderDelayNanoseconds: UInt64 = 0
    ) {
        self.result = result
        self.renderDelayNanoseconds = renderDelayNanoseconds
    }

    func render(entry: SurfAcePaneEntry?, restoreViewport: SurfAceViewport?) {}

    func renderBrowserURL(entry: SurfAcePaneEntry) async -> SurfAceBrowserNavigationResult {
        renderedBrowserURLEntries.append(entry)
        if renderDelayNanoseconds > 0 {
            try? await Task.sleep(nanoseconds: renderDelayNanoseconds)
        }
        return result
    }

    func setInteraction(annotationMode: Bool, fingerDrawEnabled: Bool) {}

    func restoreDrawing(from drawingData: Data, strokes: [SurfAceStroke]) -> Bool {
        true
    }

    func captureDrawingData() -> Data {
        Data()
    }

    func fetchSnapshot(includeImage: Bool) async -> SurfAceSurfaceSnapshot? {
        nil
    }

    func applyHTMLPatch(_ patch: SurfAceFramePatchRequest) async -> SurfAceHTMLPatchResult {
        .failed("not implemented")
    }

    func removeDrawingStrokeIDs(_ strokeIDs: [String]) {}

    func clearDrawings() {}
}
