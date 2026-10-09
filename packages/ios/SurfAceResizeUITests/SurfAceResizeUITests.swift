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

    func testDragInAuthorityBackedPaneTreeCommitsOnlyAtEnd() {
        checkDrag(probe: "tree-authority", weightIdentifier: "surf-ace-resize-tree-weight")
    }

    @available(iOS 26.0, *)
    @MainActor
    func testAuthorityBackedDragCPUAndHitches() {
        let app = XCUIApplication()
        let options = XCTMeasureOptions.default
        options.iterationCount = 3
        options.invocationOptions = [.manuallyStart, .manuallyStop]
        measure(metrics: [XCTCPUMetric(application: app), XCTHitchMetric(application: app)], options: options) {
            app.launchEnvironment["SURF_ACE_RESIZE_PROBE"] = "tree-authority"
            app.launch()
            let handle = app.images["surf-ace-split-resize-handle"]
            let weight = app.staticTexts["surf-ace-resize-tree-weight"]
            let revision = app.staticTexts["surf-ace-resize-tree-revision"]
            let content = app.staticTexts["surf-ace-resize-authority-content"]
            XCTAssertTrue(handle.waitForExistence(timeout: 10))
            XCTAssertEqual(content.label, "authority content retained")
            let before = Int(revision.label.replacingOccurrences(of: "topology revision ", with: "")) ?? -1
            Thread.sleep(forTimeInterval: 0.5) // Warm the two WebKit panes outside the measured interval.

            let start = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            let end = start.withOffset(CGVector(dx: 100, dy: 0))
            startMeasuring()
            start.press(forDuration: 0.2, thenDragTo: end)
            let changed = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "label != %@", "first weight 1.000"), object: weight
            )
            XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 5), .completed)
            var previousRevision = ""
            var stableReads = 0
            for _ in 0..<20 {
                let current = revision.label
                stableReads = current == previousRevision ? stableReads + 1 : 0
                if stableReads >= 3 { break }
                previousRevision = current
                Thread.sleep(forTimeInterval: 0.1)
            }
            stopMeasuring()
            let after = Int(revision.label.replacingOccurrences(of: "topology revision ", with: "")) ?? -1
            XCTAssertEqual(content.label, "authority content retained")
            print("resize_metric_iteration initial_revision=\(before) final_revision=\(after)")
            app.terminate()
        }
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
        let authorityContent = app.staticTexts["surf-ace-resize-authority-content"]
        if probe == "tree-authority" {
            XCTAssertEqual(authorityContent.label, "authority content retained")
        }

        let start = handle.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let end = start.withOffset(CGVector(dx: horizontal ? 0 : 100, dy: horizontal ? 100 : 0))
        let dragBegan = Date()
        start.press(forDuration: 0.2, thenDragTo: end)

        let changed = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label != %@", "first weight 1.000"),
            object: weight
        )
        XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 5), .completed)
        let value = Double(weight.label.replacingOccurrences(of: "first weight ", with: ""))
        XCTAssertNotNil(value)
        XCTAssertGreaterThan(value ?? 0, 1.10, "The full drag must persist, not just the first touch movement")
        let visibleElapsed = Date().timeIntervalSince(dragBegan)
        Thread.sleep(forTimeInterval: 0.5)
        if probe == "tree-authority" {
            XCTAssertEqual(authorityContent.label, "authority content retained")
        }
        if let initialRevision {
            let finalRevision = Int(revision.label.replacingOccurrences(of: "topology revision ", with: ""))
            print("resize_authority_result probe=\(probe) initial_revision=\(initialRevision) final_revision=\(finalRevision ?? -1) visible_elapsed_seconds=\(visibleElapsed)")
        }
        if let initialRevision {
            XCTAssertEqual(
                Int(revision.label.replacingOccurrences(of: "topology revision ", with: "")),
                initialRevision + 1,
                "One completed drag must make one committed topology change"
            )
        }
    }
}
