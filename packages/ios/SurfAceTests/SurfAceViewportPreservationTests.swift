import UIKit
import XCTest
@testable import SurfAce

@MainActor
final class SurfAceViewportPreservationTests: XCTestCase {
    func testSceneDisconnectObserverFiresOnDisconnectNotification() async {
        let notificationCenter = NotificationCenter()
        let sceneObject = NSObject()
        let expectation = expectation(description: "disconnect callback")

        let observer = SurfAceSceneDisconnectObserver(notificationCenter: notificationCenter) {
            expectation.fulfill()
        }

        observer.observe(sceneObject: sceneObject)
        notificationCenter.post(name: UIScene.didDisconnectNotification, object: sceneObject)

        await fulfillment(of: [expectation], timeout: 1)
    }

    func testSceneDisconnectObserverDoesNotFireOnDeinitWithoutDisconnect() async {
        let notificationCenter = NotificationCenter()
        let sceneObject = NSObject()
        var disconnectCount = 0

        var observer: SurfAceSceneDisconnectObserver? = SurfAceSceneDisconnectObserver(
            notificationCenter: notificationCenter
        ) {
            disconnectCount += 1
        }

        observer?.observe(sceneObject: sceneObject)
        observer = nil
        notificationCenter.post(name: UIScene.didDisconnectNotification, object: sceneObject)
        await Task.yield()

        XCTAssertEqual(disconnectCount, 0)
    }

    func testPreservesViewportForReplaceInPlaceHTMLUpdates() {
        let runtime = SurfAceRuntime()
        let currentEntry = SurfAcePaneEntry(
            contentId: "ct_deadbeef",
            revision: 3,
            historyOwnerToken: "owner-1",
            contentType: .html,
            payload: .html(html: "<p>before</p>", baseURL: nil),
            title: nil,
            scrollable: true,
            interactive: true,
            url: nil,
            drawingData: Data(),
            strokesById: [:]
        )
        let incomingFrame = SurfAceFrame(
            contentId: "ct_cafefeed",
            revision: 4,
            contentType: .html,
            payload: .html(html: "<p>after</p>", baseURL: nil),
            title: nil,
            scrollable: true,
            interactive: true
        )

        XCTAssertTrue(
            runtime.shouldPreserveHTMLViewportAcrossContentSet(
                currentEntry: currentEntry,
                incomingFrame: incomingFrame,
                historyOwnerToken: "owner-1"
            )
        )
    }

    func testDoesNotPreserveViewportWhenHistoryOwnerChanges() {
        let runtime = SurfAceRuntime()
        let currentEntry = SurfAcePaneEntry(
            contentId: "ct_deadbeef",
            revision: 3,
            historyOwnerToken: "owner-1",
            contentType: .html,
            payload: .html(html: "<p>before</p>", baseURL: nil),
            title: nil,
            scrollable: true,
            interactive: true,
            url: nil,
            drawingData: Data(),
            strokesById: [:]
        )
        let incomingFrame = SurfAceFrame(
            contentId: "ct_cafefeed",
            revision: 4,
            contentType: .html,
            payload: .html(html: "<p>after</p>", baseURL: nil),
            title: nil,
            scrollable: true,
            interactive: true
        )

        XCTAssertFalse(
            runtime.shouldPreserveHTMLViewportAcrossContentSet(
                currentEntry: currentEntry,
                incomingFrame: incomingFrame,
                historyOwnerToken: "owner-2"
            )
        )
    }

    func testDoesNotPreserveViewportForNonHTMLUpdates() {
        let runtime = SurfAceRuntime()
        let currentEntry = SurfAcePaneEntry(
            contentId: "ct_deadbeef",
            revision: 3,
            historyOwnerToken: "owner-1",
            contentType: .html,
            payload: .html(html: "<p>before</p>", baseURL: nil),
            title: nil,
            scrollable: true,
            interactive: true,
            url: nil,
            drawingData: Data(),
            strokesById: [:]
        )
        let incomingFrame = SurfAceFrame(
            contentId: "ct_cafefeed",
            revision: 4,
            contentType: .markdown,
            payload: .markdown(markdown: "# after"),
            title: nil,
            scrollable: true,
            interactive: true
        )

        XCTAssertFalse(
            runtime.shouldPreserveHTMLViewportAcrossContentSet(
                currentEntry: currentEntry,
                incomingFrame: incomingFrame,
                historyOwnerToken: "owner-1"
            )
        )
    }

    func testBrowserURLPaneEntryIsDistinctFromStaticHTML() {
        let entry = SurfAcePaneEntry.browserURL(
            targetId: "tg_google",
            targetEpoch: 1,
            url: "https://google.com/",
            allowedSnapshotFallback: true,
            fallbackSnapshotTargetId: "tg_snapshot"
        )

        XCTAssertNil(entry.contentId)
        XCTAssertEqual(entry.revision, 1)
        XCTAssertNil(entry.contentType)
        XCTAssertEqual(
            entry.payload,
            .browserURL(
                url: "https://google.com/",
                allowedSnapshotFallback: true,
                fallbackSnapshotTargetId: "tg_snapshot"
            )
        )
        XCTAssertEqual(entry.url, "https://google.com/")
    }

    func testContentApplyParserRejectsBrowserURLAsStaticContent() {
        XCTAssertThrowsError(
            try SurfAceFrame.from(
                contentId: "ct_cafefeed",
                revision: 1,
                jsonObject: [
                    "contentType": "browser_url",
                    "content": ["url": "https://google.com/"],
                ]
            )
        ) { error in
            guard case SurfAceFrameParseError.unsupportedType = error else {
                XCTFail("Unexpected error: \(error)")
                return
            }
        }
    }
}
