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

    func testPaneOwnerDisplayNameTracksVisibleHistoryEntry() {
        let pane = SurfAcePaneModel(paneId: 7, paneLabel: 12)
        pane.currentEntry = SurfAcePaneEntry(
            contentId: "ct_a",
            revision: 1,
            historyOwnerToken: "owner-a",
            contentType: .markdown,
            payload: .markdown(markdown: "# A"),
            title: "Session A",
            scrollable: true,
            interactive: true,
            url: nil,
            drawingData: Data(),
            strokesById: [:]
        )
        pane.backStack.append(
            SurfAcePaneEntry(
                contentId: "ct_b",
                revision: 2,
                historyOwnerToken: "owner-b",
                contentType: .markdown,
                payload: .markdown(markdown: "# B"),
                title: "Session B",
                scrollable: true,
                interactive: true,
                url: nil,
                drawingData: Data(),
                strokesById: [:]
            )
        )

        XCTAssertEqual(pane.currentOwnerDisplayName(), "Session A")
        pane.forwardStack.append(pane.currentEntry)
        pane.currentEntry = pane.backStack.removeLast()
        XCTAssertEqual(pane.currentOwnerDisplayName(), "Session B")
    }

    func testPaneOwnerDisplayNameDoesNotFallBackToProviderName() {
        let pane = SurfAcePaneModel(paneId: 1, paneLabel: 1)
        pane.currentEntry = SurfAcePaneEntry(
            contentId: "ct_a",
            revision: 1,
            historyOwnerToken: "owner-a",
            contentType: .markdown,
            payload: .markdown(markdown: "# A"),
            title: nil,
            scrollable: true,
            interactive: true,
            url: nil,
            drawingData: Data(),
            strokesById: [:]
        )

        XCTAssertNil(pane.currentOwnerDisplayName())
    }
}
