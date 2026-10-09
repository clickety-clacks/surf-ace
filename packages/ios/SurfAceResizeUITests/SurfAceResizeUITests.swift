import XCTest

final class SurfAceResizeUITests: XCTestCase {
    func testDragAcrossLocalWebContentChangesSplitWeight() {
        checkDrag(probe: "1", weightIdentifier: "surf-ace-resize-probe-weight")
    }

    func testDragInRealPaneTreeChangesSplitWeight() {
        checkDrag(probe: "tree", weightIdentifier: "surf-ace-resize-tree-weight")
    }

    func testHorizontalDragInRealPaneTreeChangesSplitWeight() {
        checkDrag(probe: "tree-horizontal", weightIdentifier: "surf-ace-resize-tree-weight", horizontal: true)
    }

    private func checkDrag(probe: String, weightIdentifier: String, horizontal: Bool = false) {
        let app = XCUIApplication()
        app.launchEnvironment["SURF_ACE_RESIZE_PROBE"] = probe
        app.launch()

        let weight = app.staticTexts[weightIdentifier]
        let handle = app.images["surf-ace-split-resize-handle"]
        XCTAssertTrue(weight.waitForExistence(timeout: 10))
        XCTAssertTrue(handle.waitForExistence(timeout: 10))
        XCTAssertEqual(weight.label, "first weight 1.000")
        let revision = app.staticTexts["surf-ace-resize-tree-revision"]
        let initialRevision = probe.hasPrefix("tree")
            ? Int(revision.label.replacingOccurrences(of: "topology revision ", with: "")) : nil
        if probe.hasPrefix("tree") { XCTAssertNotNil(initialRevision) }

        let start = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let end = start.withOffset(CGVector(dx: horizontal ? 0 : 100, dy: horizontal ? 100 : 0))
        start.press(forDuration: 0.2, thenDragTo: end)

        let changed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label != %@", "first weight 1.000"),
            object: weight
        )
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 5), .completed)
        let value = Double(weight.label.replacingOccurrences(of: "first weight ", with: ""))
        XCTAssertNotNil(value)
        XCTAssertGreaterThan(value ?? 0, 1.10, "The full drag must persist, not just the first touch movement")
        if let initialRevision {
            XCTAssertEqual(
                Int(revision.label.replacingOccurrences(of: "topology revision ", with: "")),
                initialRevision + 1,
                "One completed drag must make one committed topology change"
            )
        }
    }
}
