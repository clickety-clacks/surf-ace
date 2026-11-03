import XCTest

/// Exercises the shipping SwiftUI controls using the public Siri Remote API.
/// The target application is the isolated fixture executable, never SurfAceTV.
@MainActor
final class SurfAceTVRemoteTests: XCTestCase {
    private let remote = XCUIRemote.shared

    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testRemoteAnnotationBackAndDoneOnEveryAcceptedType() throws {
        for type in ["image", "terminal", "markdown", "pdf"] {
            let app = launch(content: type, scenario: "annotation")
            defer { app.terminate() }
            let before = telemetry(app)
            attach(app, "\(type)-before-annotation")
            try select(app.buttons["Annotate"].firstMatch, in: app)
            wait(app, "Annotation mode opens") { self.telemetry(app)["annotationMode"] as? Bool == true }
            let cursor = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Select starts stroke")).firstMatch
            try focus(cursor, in: app)
            remote.press(.select)
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Select ends stroke")).firstMatch.waitForExistence(timeout: 5))
            remote.press(.right)
            remote.press(.down)
            remote.press(.select)
            wait(app, "Remote directions produce distinct captured points") {
                let state = self.telemetry(app)
                return state["strokeCount"] as? Int == 1 && (state["distinctPointCount"] as? Int ?? 0) >= 3
            }
            attach(app, "\(type)-stroke-ended")
            remote.press(.menu)
            XCTAssertTrue(app.buttons["Annotate"].firstMatch.waitForExistence(timeout: 5))
            wait(app, "Back preserves annotation mode and captured stroke") {
                let state = self.telemetry(app)
                return state["annotationMode"] as? Bool == true && state["strokeCount"] as? Int == 1
            }
            attach(app, "\(type)-back-preserves-stroke")

            try select(app.buttons["Annotate"].firstMatch, in: app)
            try focus(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Select starts stroke")).firstMatch, in: app)
            // The shipping cursor explicitly maps Play/Pause to existing Done.
            remote.press(.playPause)
            wait(app, "Done finalizes annotation and clears native drawing") {
                let state = self.telemetry(app)
                return state["annotationMode"] as? Bool == false && state["nativeStrokeCount"] as? Int == 0
            }
            XCTAssertEqual(telemetry(app)["contentIDs"] as? [String], before["contentIDs"] as? [String])
            XCTAssertEqual(telemetry(app)["revision"] as? Int, before["revision"] as? Int)
            attach(app, "\(type)-done")
            app.terminate()
        }
    }

    func testRemoteResizeCancelsThenCommitsExactlyOnce() throws {
        let app = launch(content: "terminal", scenario: "arrangement")
        defer { app.terminate() }
        let before = telemetry(app)
        let revision = try XCTUnwrap(before["revision"] as? Int)
        attach(app, "arrangement-before")

        try beginResize(app)
        remote.press(.right)
        attach(app, "arrangement-cancel-preview")
        XCTAssertEqual(telemetry(app)["revision"] as? Int, revision)
        remote.press(.menu)
        XCTAssertTrue(app.buttons["Arrange panes"].waitForExistence(timeout: 5))
        XCTAssertEqual(telemetry(app)["revision"] as? Int, revision)
        XCTAssertEqual(telemetry(app)["layout"] as? String, before["layout"] as? String)
        XCTAssertEqual(telemetry(app)["contentIDs"] as? [String], before["contentIDs"] as? [String])
        attach(app, "arrangement-cancelled")

        try beginResize(app)
        remote.press(.right)
        attach(app, "arrangement-confirm-preview")
        remote.press(.playPause)
        wait(app, "One confirmed resize advances authority once") {
            self.telemetry(app)["revision"] as? Int == revision + 1
        }
        XCTAssertTrue(app.buttons["Arrange panes"].waitForExistence(timeout: 5))
        XCTAssertNotEqual(telemetry(app)["layout"] as? String, before["layout"] as? String)
        XCTAssertEqual(telemetry(app)["contentIDs"] as? [String], before["contentIDs"] as? [String])
        let extraCommit = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            (self.telemetry(app)["revision"] as? Int ?? -1) > revision + 1
        }, object: nil)
        extraCommit.isInverted = true
        XCTAssertEqual(XCTWaiter.wait(for: [extraCommit], timeout: 1), .completed)
        attach(app, "arrangement-confirmed")
    }

    func testRemotePDFPagingAndScalePreserveSelectedPage() throws {
        let app = launch(content: "pdf", scenario: "annotation")
        defer { app.terminate() }
        let before = telemetry(app)
        try select(app.buttons["Page +"], in: app)
        wait(app, "Remote advances to the actual second PDF page") { self.telemetry(app)["page"] as? Int == 2 }
        attach(app, "pdf-second-page")
        try select(app.buttons["+"], in: app)
        wait(app, "Remote increases content scale") { (self.telemetry(app)["scale"] as? Double ?? 1) > 1 }
        XCTAssertEqual(telemetry(app)["page"] as? Int, 2)
        XCTAssertEqual(telemetry(app)["contentIDs"] as? [String], before["contentIDs"] as? [String])
        attach(app, "pdf-scaled-second-page")
        try select(app.buttons["Reset scale"], in: app)
        wait(app, "Scale resets without changing PDF page") { self.telemetry(app)["scale"] as? Double == 1 }
        XCTAssertEqual(telemetry(app)["page"] as? Int, 2)
    }

    func testDiagnosticDismissRevealsUnchangedAcceptedImage() throws {
        let app = launch(content: "image", scenario: "diagnostic")
        defer { app.terminate() }
        let before = telemetry(app)
        XCTAssertEqual(before["diagnostic"] as? Bool, true)
        XCTAssertFalse(app.buttons["Annotate"].exists)
        XCTAssertTrue(app.staticTexts["Shown as text. Apple TV can't display web pages."].exists)
        attach(app, "html-rejected-diagnostic")
        try select(app.buttons["Dismiss"], in: app)
        wait(app, "Dismiss reveals accepted image") { self.telemetry(app)["diagnostic"] as? Bool == false }
        XCTAssertTrue(app.buttons["Annotate"].exists)
        XCTAssertEqual(telemetry(app)["contentIDs"] as? [String], before["contentIDs"] as? [String])
        XCTAssertEqual(telemetry(app)["revision"] as? Int, before["revision"] as? Int)
        attach(app, "html-dismissed-image-unchanged")
    }

    func testRemoteHistoryAndScrollingPreserveAcceptedEntries() throws {
        let app = launch(content: "terminal", scenario: "history")
        defer { app.terminate() }
        let before = telemetry(app)
        XCTAssertEqual(before["contentIDs"] as? [String], ["history-second"])
        try select(app.buttons["Scroll / pan"], in: app)
        try select(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Select to pan")).firstMatch, in: app)
        remote.press(.down)
        wait(app, "Remote scroll moves the native terminal viewport") { (self.telemetry(app)["scrollY"] as? Double ?? 0) > 0 }
        remote.press(.menu)
        try select(app.buttons["Previous"], in: app)
        wait(app, "Previous restores the first accepted entry") { self.telemetry(app)["contentIDs"] as? [String] != ["history-second"] }
        attach(app, "history-previous")
        try select(app.buttons["Next"], in: app)
        wait(app, "Next restores the second accepted entry") { self.telemetry(app)["contentIDs"] as? [String] == ["history-second"] }
        XCTAssertEqual(telemetry(app)["revision"] as? Int, before["revision"] as? Int)
        attach(app, "history-next")
    }

    func testRemoteSurfaceSelectionPreservesBothIdentitiesAndContent() throws {
        let app = launch(content: "image", scenario: "surfaces")
        defer { app.terminate() }
        let before = telemetry(app)
        let names = try XCTUnwrap(before["surfaceNames"] as? [String])
        let ids = try XCTUnwrap(before["surfaceIDs"] as? [String])
        XCTAssertEqual(names.count, 2)
        try select(app.buttons[names[1]], in: app)
        wait(app, "Second surface becomes the only mounted surface") { self.telemetry(app)["mountedSurfaces"] as? [String] == [ids[1]] }
        attach(app, "second-surface-selected")
        try select(app.buttons[names[0]], in: app)
        wait(app, "Original surface returns unchanged") { self.telemetry(app)["mountedSurfaces"] as? [String] == [ids[0]] }
        XCTAssertEqual(telemetry(app)["surfaceIDs"] as? [String], ids)
        XCTAssertEqual(telemetry(app)["allContentIDs"] as? [String], before["allContentIDs"] as? [String])
        attach(app, "first-surface-restored")
    }

    private func beginResize(_ app: XCUIApplication) throws {
        try select(app.buttons["Arrange panes"], in: app)
        try select(app.buttons["Resize"], in: app)
        try select(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Preview")).firstMatch, in: app)
    }

    private func launch(content: String, scenario: String) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["SURF_ACE_XCTEST_HOST_NO_AUTOSTART"] = "1"
        app.launchEnvironment["REMOTE_FIXTURE_CONTENT"] = content
        app.launchEnvironment["REMOTE_FIXTURE_SCENARIO"] = scenario
        app.launch()
        wait(app, "Isolated host seeds accepted content") { self.telemetry(app)["ready"] as? Bool == true }
        return app
    }

    private func select(_ target: XCUIElement, in app: XCUIApplication) throws {
        try focus(target, in: app)
        XCTAssertTrue(target.hasFocus, "Select must activate the intended focused control")
        remote.press(.select)
    }

    private func focus(_ target: XCUIElement, in app: XCUIApplication) throws {
        XCTAssertTrue(target.waitForExistence(timeout: 5), "Target absent: \(target)")
        // Geometry chooses only a direction; it never taps or synthesizes a
        // control action. Each press still traverses the actual focus engine.
        var navigation: [String] = []
        defer {
            let trace = XCTAttachment(string: navigation.joined(separator: "\n"))
            trace.name = "focus-route-to-\(target.label)"
            trace.lifetime = .keepAlways
            add(trace)
        }
        for _ in 0..<20 {
            if target.hasFocus { return }
            guard let current = app.descendants(matching: .any).allElementsBoundByIndex.first(where: { $0.hasFocus }) else {
                navigation.append("No focused element; target=\(target.label) frame=\(target.frame)")
                attach(app, "missing-focus")
                throw RemoteFailure.noFocusedElement
            }
            let targetFrame = target.frame
            let currentFrame = current.frame
            // First move between disjoint rows. Comparing center distances
            // can oscillate between wide-spaced pane headers below a centered
            // target instead of ever sending the necessary Up command.
            let direction: XCUIRemote.Button
            if targetFrame.maxY <= currentFrame.minY {
                direction = .up
            } else if targetFrame.minY >= currentFrame.maxY {
                direction = .down
            } else {
                direction = targetFrame.midX < currentFrame.midX ? .left : .right
            }
            navigation.append("from=\(current.label) frame=\(currentFrame); target=\(target.label) frame=\(targetFrame); direction=\(direction)")
            remote.press(direction)
        }
        attach(app, "unreachable-focus-\(target.label)")
        XCTFail("Remote could not focus \(target.label). See hierarchy and screenshot.")
        throw RemoteFailure.unreachableTarget
    }

    private func telemetry(_ app: XCUIApplication) -> [String: Any] {
        let element = app.staticTexts["remote-fixture-telemetry"]
        guard element.exists, let data = element.label.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return [:] }
        return object
    }

    private func wait(_ app: XCUIApplication, _ description: String, condition: @escaping () -> Bool) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in condition() }, object: nil)
        let result = XCTWaiter.wait(for: [expectation], timeout: 10)
        if result != .completed { attach(app, "failed-\(description)") }
        XCTAssertEqual(result, .completed, description)
    }

    private func attach(_ app: XCUIApplication, _ name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(name)-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    private enum RemoteFailure: Error { case noFocusedElement, unreachableTarget }
}
