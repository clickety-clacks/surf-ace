import XCTest
import SwiftUI
import WebKit
import CryptoKit
@testable import SurfAce

final class SurfAceSurfaceTopologyPersistenceTests: XCTestCase {
    @MainActor
    func testFractionalSurvivorWeightsFillSurfaceAfterPaneClose() {
        let bounds = CGRect(x: 0, y: 0, width: 1000, height: 800)
        // Closing siblings can leave valid relative weights whose sum is below
        // one. They still partition the entire available surface.
        let horizontal = [0.24, 0.26]
        let left = surfAceSplitChildBounds(parent: bounds, direction: .vertical,
                                           weights: horizontal, index: 0)
        let right = surfAceSplitChildBounds(parent: bounds, direction: .vertical,
                                            weights: horizontal, index: 1)
        XCTAssertEqual(left.width, 480, accuracy: 0.001)
        XCTAssertEqual(right.minX, left.maxX, accuracy: 0.001)
        XCTAssertEqual(right.maxX, bounds.maxX, accuracy: 0.001)

        let vertical = [0.1, 0.2]
        let top = surfAceSplitChildBounds(parent: bounds, direction: .horizontal,
                                          weights: vertical, index: 0)
        let bottom = surfAceSplitChildBounds(parent: bounds, direction: .horizontal,
                                             weights: vertical, index: 1)
        XCTAssertEqual(bottom.minY, top.maxY, accuracy: 0.001)
        XCTAssertEqual(bottom.maxY, bounds.maxY, accuracy: 0.001)
    }

    @MainActor
    func testMountedPaneCloseFillsVacatedRegionWithoutReloadingSurvivors() async throws {
        let name = "SurfAcePaneCloseFixture.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let runtime = SurfAceRuntime(userDefaults: defaults, enableFleetDiscovery: false,
                                     isolatedTestLoopback: true)
        let surface = runtime.registerSurface(sceneKey: name)
        let panes = (1...4).map { SurfAcePaneModel(paneId: $0, paneLabel: $0) }
        for pane in panes {
            pane.currentEntry = SurfAcePaneEntry.from(frame: SurfAceFrame(
                contentId: "close-\(pane.paneId)", revision: 1, contentType: .html,
                payload: .html(html: "<html><head><title>close-\(pane.paneId)</title></head><body><script>window.sessionToken=Math.random().toString();</script>Pane \(pane.paneId)</body></html>", baseURL: nil),
                reloadSource: nil, title: "Pane", scrollable: true, interactive: true))
        }
        surface.panesById = Dictionary(uniqueKeysWithValues: panes.map { ($0.paneId, $0) })
        surface.paneLayout = .split(direction: .vertical, children: [
            .leaf(1, weight: 0.24), .leaf(2, weight: 0.26),
            .split(direction: .horizontal,
                   children: [.leaf(3, weight: 0.5), .leaf(4, weight: 0.5)], weight: 0.5),
        ])

        let host = UIHostingController(rootView: SurfAceWindowView(runtime: runtime, surface: surface))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1000, height: 800)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKey()
        }
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        let initialViews = popoutWebViews(in: host.view)
        XCTAssertEqual(initialViews.count, 4)
        let ready = initialViews.map { _ in expectation(description: "local pane page loaded") }
        let observations = zip(initialViews, ready).map { view, signal in
            view.observe(\.title, options: [.initial, .new]) { view, _ in
                if view.title?.hasPrefix("close-") == true { signal.fulfill() }
            }
        }
        await fulfillment(of: ready, timeout: 10)
        observations.forEach { $0.invalidate() }
        let first = try XCTUnwrap(initialViews.first { $0.title == "close-1" })
        let second = try XCTUnwrap(initialViews.first { $0.title == "close-2" })
        let firstTokenValue = try await first.evaluateJavaScript("window.sessionToken") as? String
        let secondTokenValue = try await second.evaluateJavaScript("window.sessionToken") as? String
        let firstToken = try XCTUnwrap(firstTokenValue)
        let secondToken = try XCTUnwrap(secondTokenValue)
        let available = initialViews.map { $0.convert($0.bounds, to: window) }
            .reduce(CGRect.null) { $0.union($1) }

        // Project the accepted close result: panes 3 and 4 and their obsolete
        // split are gone; surviving relative weights still sum to only 0.5.
        surface.panesById.removeValue(forKey: 3)
        surface.panesById.removeValue(forKey: 4)
        surface.paneLayout = .split(direction: .vertical,
                                    children: [.leaf(1, weight: 0.24), .leaf(2, weight: 0.26)])
        surface.topologyEpoch += 1
        await waitForPopoutFrame(first, in: window,
                                expected: surfAceSplitChildBounds(parent: available, direction: .vertical,
                                                                  weights: [0.24, 0.26], index: 0))
        await waitForPopoutFrame(second, in: window,
                                expected: surfAceSplitChildBounds(parent: available, direction: .vertical,
                                                                  weights: [0.24, 0.26], index: 1))
        XCTAssertEqual(Set(popoutWebViews(in: host.view).map(ObjectIdentifier.init)),
                       Set([first, second].map(ObjectIdentifier.init)))
        let retainedFirstToken = try await first.evaluateJavaScript("window.sessionToken") as? String
        let retainedSecondToken = try await second.evaluateJavaScript("window.sessionToken") as? String
        XCTAssertEqual(retainedFirstToken, firstToken)
        XCTAssertEqual(retainedSecondToken, secondToken)
    }

    @MainActor
    func testMountedSurvivorsKeepWebViewsThroughNestedCloseAndCollapse() async throws {
        let name = "SurfAceNestedCloseFixture.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        let runtime = SurfAceRuntime(userDefaults: defaults, enableFleetDiscovery: false,
                                     isolatedTestLoopback: true)
        let surface = runtime.registerSurface(sceneKey: name)
        let panes = (1...4).map { SurfAcePaneModel(paneId: $0, paneLabel: $0) }
        for pane in panes {
            pane.currentEntry = SurfAcePaneEntry.from(frame: SurfAceFrame(
                contentId: "nested-close-\(pane.paneId)", revision: 1, contentType: .html,
                payload: .html(html: "<html><head><title>nested-\(pane.paneId)</title></head><body><script>window.sessionToken=Math.random().toString();</script></body></html>", baseURL: nil),
                reloadSource: nil, title: "Pane", scrollable: true, interactive: true))
        }
        surface.panesById = Dictionary(uniqueKeysWithValues: panes.map { ($0.paneId, $0) })
        surface.paneLayout = .split(direction: .vertical, children: [
            .leaf(1, weight: 0.5),
            .split(direction: .horizontal, children: [
                .leaf(2, weight: 0.2), .leaf(3, weight: 0.3), .leaf(4, weight: 0.5),
            ], weight: 0.5),
        ])

        let host = UIHostingController(rootView: SurfAceWindowView(runtime: runtime, surface: surface))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1000, height: 800)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKey()
        }
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        let initialViews = popoutWebViews(in: host.view)
        XCTAssertEqual(initialViews.count, 4)
        let ready = initialViews.map { _ in expectation(description: "nested pane page loaded") }
        let observations = zip(initialViews, ready).map { view, signal in
            view.observe(\.title, options: [.initial, .new]) { view, _ in
                if view.title?.hasPrefix("nested-") == true { signal.fulfill() }
            }
        }
        await fulfillment(of: ready, timeout: 10)
        observations.forEach { $0.invalidate() }
        let first = try XCTUnwrap(initialViews.first { $0.title == "nested-1" })
        let second = try XCTUnwrap(initialViews.first { $0.title == "nested-2" })
        let third = try XCTUnwrap(initialViews.first { $0.title == "nested-3" })
        let tokens = try await popoutSessionTokens([first, second, third])

        // The nested split survives this close, but its descendants change.
        surface.panesById.removeValue(forKey: 4)
        surface.paneLayout = .split(direction: .vertical, children: [
            .leaf(1, weight: 0.5),
            .split(direction: .horizontal, children: [
                .leaf(2, weight: 0.2), .leaf(3, weight: 0.3),
            ], weight: 0.5),
        ])
        surface.topologyEpoch += 1
        await waitForMountedWebViews([first, second, third], in: host.view)
        let retainedNestedTokens = try await popoutSessionTokens([first, second, third])
        XCTAssertEqual(retainedNestedTokens, tokens)

        // Removing the preceding nested sibling collapses its split and
        // reparents pane 3; neither its view nor its script state may reset.
        surface.panesById.removeValue(forKey: 2)
        surface.paneLayout = .split(direction: .vertical, children: [
            .leaf(1, weight: 0.5), .leaf(3, weight: 0.5),
        ])
        surface.topologyEpoch += 1
        await waitForMountedWebViews([first, third], in: host.view)
        let retainedCollapsedTokens = try await popoutSessionTokens([first, third])
        XCTAssertEqual(retainedCollapsedTokens, [tokens[0], tokens[2]])

        // A final preceding-sibling close collapses the root itself.
        surface.panesById.removeValue(forKey: 1)
        surface.paneLayout = .leaf(3)
        surface.topologyEpoch += 1
        await waitForMountedWebViews([third], in: host.view)
        let retainedRootToken = try await popoutSessionTokens([third])
        XCTAssertEqual(retainedRootToken, [tokens[2]])
    }

    @MainActor
    func testPopoutGeometryAndReconciliationDoNotReplayTopology() {
        let portrait = CGRect(x: 0, y: 0, width: 600, height: 900)
        let right = surfAceSplitChildBounds(parent: portrait, direction: .vertical,
                                            weights: [1, 3], index: 1)
        let nested = surfAceSplitChildBounds(parent: right, direction: .horizontal,
                                             weights: [2, 1], index: 1)
        XCTAssertEqual(nested, CGRect(x: 150, y: 600, width: 450, height: 300))
        XCTAssertEqual(surfAcePanePopoutBounds(in: portrait),
                       CGRect(x: 20, y: 20, width: 560, height: 860))
        let landscape = CGRect(x: 0, y: 0, width: 900, height: 600)
        XCTAssertEqual(surfAceSplitChildBounds(parent: landscape, direction: .vertical,
                                              weights: [1, 3], index: 1).width, 675)
        XCTAssertEqual(surfAcePanePopoutBounds(in: landscape).size, CGSize(width: 860, height: 560))
        let selection = SurfAcePanePopoutPresentation()
        let otherWindow = SurfAcePanePopoutPresentation()
        selection.paneId = 3
        otherWindow.paneId = 2
        selection.reconcile(paneIds: [1, 2, 3], topologyChanged: false)
        XCTAssertEqual(selection.paneId, 3)
        selection.reconcile(paneIds: [1, 2], topologyChanged: false)
        XCTAssertNil(selection.paneId)
        XCTAssertEqual(otherWindow.paneId, 2)
        selection.paneId = 2
        selection.reconcile(paneIds: [1, 2], topologyChanged: true)
        XCTAssertNil(selection.paneId)
    }

    @MainActor
    func testMountedWebKitPopoutRetainsNestedPaneAndSiblingSessions() async throws {
        let name = "SurfAcePopoutFixture.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        // Never start this runtime: this fixture owns only local view state.
        let runtime = SurfAceRuntime(userDefaults: defaults, enableFleetDiscovery: false,
                                     isolatedTestLoopback: true)
        let surface = runtime.registerSurface(sceneKey: name)
        let panes = (1...3).map { SurfAcePaneModel(paneId: $0, paneLabel: $0) }
        for pane in panes {
            pane.currentEntry = SurfAcePaneEntry.from(frame: SurfAceFrame(
                contentId: "popout-\(pane.paneId)", revision: 1, contentType: .html,
                payload: .html(html: "<html><head><title>ready-\(pane.paneId)</title></head><body><script>window.counter=1;window.sessionToken=Math.random().toString();</script>Pane \(pane.paneId)</body></html>", baseURL: nil),
                reloadSource: nil, title: "Pane", scrollable: true, interactive: true))
        }
        surface.panesById = Dictionary(uniqueKeysWithValues: panes.map { ($0.paneId, $0) })
        surface.paneLayout = .split(direction: .vertical, children: [
            .leaf(1, weight: 1), .split(direction: .horizontal,
                children: [.leaf(2, weight: 2), .leaf(3, weight: 1)], weight: 3),
        ])
        let originalLayout = SurfAcePersistedPaneLayoutNode(from: surface.paneLayout)
        let originalEpoch = surface.topologyEpoch
        let selection = SurfAcePanePopoutPresentation()
        let host = UIHostingController(rootView: SurfAceWindowView(
            runtime: runtime, surface: surface, presentation: selection))
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previousKeyWindow = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 600, height: 900)
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
            previousKeyWindow?.makeKey()
        }
        host.view.frame = window.bounds
        host.view.layoutIfNeeded()
        await Task.yield()
        host.view.layoutIfNeeded()
        let views = popoutWebViews(in: host.view)
        XCTAssertEqual(views.count, 3)
        let ready = views.map { _ in expectation(description: "WebKit initial page ready") }
        let observations = zip(views, ready).map { view, signal in
            view.observe(\.title, options: [.initial, .new]) { view, _ in
                if view.title?.hasPrefix("ready-") == true { signal.fulfill() }
            }
        }
        await fulfillment(of: ready, timeout: 10)
        observations.forEach { $0.invalidate() }
        let tokens = try await popoutSessionTokens(views)
        let selected = try XCTUnwrap(views.first { $0.title == "ready-3" })
        let toggle = try XCTUnwrap(popoutToolbarButtons(in: host.view).first {
            $0.accessibilityIdentifier == "surf-ace-pane-popout-3"
        })
        XCTAssertTrue(toggle.isAccessibilityElement,
                      "the mounted native toggle provides its own accessibility target")
        XCTAssertFalse(toggle.accessibilityElementsHidden)
        for style in [UIUserInterfaceStyle.light, .dark] {
            window.overrideUserInterfaceStyle = style
            await Task.yield()
            host.view.layoutIfNeeded()
            try assertPopoutGlyphPaints(toggle, state: "Tiled-\(style.rawValue)")
        }
        var tiledFrames = views.map { $0.convert($0.bounds, to: window) }
        var surfaceFrame = tiledFrames.reduce(CGRect.null) { $0.union($1) }
        for index in 0..<4 {
            selection.paneId = 3
            await Task.yield()
            host.view.layoutIfNeeded()
            XCTAssertEqual(selection.paneId, 3)
            let expandedFrame = surfAcePanePopoutBounds(in: surfaceFrame)
            await waitForPopoutFrame(selected, in: window, expected: expandedFrame)
            let focused = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                toggle.isFirstResponder
            }, object: nil)
            await fulfillment(of: [focused], timeout: 5)
            XCTAssertTrue(toggle.isFirstResponder, "the mounted toolbar button owns keyboard input after expansion")
            try assertPopoutGlyphPaints(toggle, state: "Expanded-\(index)")
            XCTAssertTrue(popoutToolbarButtons(in: host.view).contains { $0 === toggle },
                          "enter/Restore retains the same native toggle")
            for (view, original) in zip(views, tiledFrames) where view !== selected {
                XCTAssertEqual(view.convert(view.bounds, to: window), original,
                               "covered sibling stays in its original tile")
            }
            // These points include territory outside pane 3's original tile.
            for point in [CGPoint(x: expandedFrame.minX + 30, y: expandedFrame.minY + 80),
                          CGPoint(x: expandedFrame.midX, y: expandedFrame.midY)] {
                let hit = window.hitTest(point, with: nil)
                XCTAssertTrue(hit === selected || hit?.isDescendant(of: selected) == true,
                              "expanded pane owns input across covered sibling tiles")
            }
            XCTAssertEqual(Set(popoutWebViews(in: host.view).map(ObjectIdentifier.init)),
                           Set(views.map(ObjectIdentifier.init)))
            for view in views { _ = try await view.evaluateJavaScript("++window.counter") }
            let currentTokens = try await popoutSessionTokens(views)
            XCTAssertEqual(currentTokens, tokens)
            if index == 1 {
                // Resize while expanded: derive both overlay and eventual Restore
                // from the current surface, never the previous pixel rectangles.
                let sibling = try XCTUnwrap(views.first { $0 !== selected })
                let oldWidth = sibling.bounds.width
                window.frame = CGRect(x: 0, y: 0, width: 900, height: 600)
                host.view.frame = window.bounds
                host.view.layoutIfNeeded()
                let resized = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    sibling.bounds.width != oldWidth
                }, object: nil)
                await fulfillment(of: [resized], timeout: 5)
                surfaceFrame = views.filter { $0 !== selected }.map { $0.convert($0.bounds, to: window) }
                    .reduce(CGRect.null) { $0.union($1) }
                await waitForPopoutFrame(selected, in: window,
                                        expected: surfAcePanePopoutBounds(in: surfaceFrame))
                tiledFrames = views.map { view in
                    if view !== selected { return view.convert(view.bounds, to: window) }
                    let right = surfAceSplitChildBounds(parent: surfaceFrame, direction: .vertical,
                                                        weights: [1, 3], index: 1)
                    return surfAceSplitChildBounds(parent: right, direction: .horizontal,
                                                   weights: [2, 1], index: 1)
                }
            }
            selection.paneId = nil
            await waitForPopoutFrame(selected, in: window,
                                    expected: tiledFrames[try XCTUnwrap(views.firstIndex(of: selected))])
        }
        XCTAssertTrue(toggle.accessibilityActivate(), "native accessibility invokes the same pop-out action")
        await waitForPopoutFrame(selected, in: window,
                                expected: surfAcePanePopoutBounds(in: surfaceFrame))
        XCTAssertEqual(selection.paneId, 3)
        XCTAssertTrue(toggle.accessibilityActivate(), "the same accessibility action restores the tile")
        await waitForPopoutFrame(selected, in: window,
                                expected: tiledFrames[try XCTUnwrap(views.firstIndex(of: selected))])
        XCTAssertNil(selection.paneId)
        let accessibilityTokens = try await popoutSessionTokens(views)
        XCTAssertEqual(accessibilityTokens, tokens)
        for view in views {
            let counter = try await view.evaluateJavaScript("window.counter") as? Int
            XCTAssertEqual(counter, 5, "covered sibling content stays live without reload")
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        XCTAssertEqual(try encoder.encode(SurfAcePersistedPaneLayoutNode(from: surface.paneLayout)),
                       try encoder.encode(originalLayout))
        XCTAssertEqual(surface.topologyEpoch, originalEpoch)
        selection.paneId = 3
        await waitForPopoutFrame(selected, in: window, expected: surfAcePanePopoutBounds(in: surfaceFrame))
        // Exercise the production authority-to-mounted-bridge projection while
        // presentation is active: new content is allowed, host replacement is not.
        let updated = expectation(description: "authorized revision rendered in expanded host")
        let updateObservation = selected.observe(\.title, options: [.new]) { view, _ in
            if view.title == "updated-3" { updated.fulfill() }
        }
        var projected = SurfAcePersistedSurfaceTopology(surface: surface)
        let projectedIndex = try XCTUnwrap(projected.panes.firstIndex { $0.paneId == 3 })
        projected.panes[projectedIndex].currentEntry = SurfAcePaneEntry.from(frame: SurfAceFrame(
            contentId: "popout-updated-3", revision: 2, contentType: .html,
            payload: .html(html: "<html><head><title>updated-3</title></head><body><script>window.counter=100;window.sessionToken='authorized-revision-2';</script>Updated content</body></html>", baseURL: nil),
            reloadSource: nil, title: "Updated pane", scrollable: true, interactive: true))
        runtime.project(topology: projected, onto: surface)
        await fulfillment(of: [updated], timeout: 10)
        updateObservation.invalidate()
        XCTAssertEqual(selection.paneId, 3)
        XCTAssertTrue(popoutWebViews(in: host.view).contains { $0 === selected })
        await waitForPopoutFrame(selected, in: window, expected: surfAcePanePopoutBounds(in: surfaceFrame))
        for (view, token) in zip(views, tokens) where view !== selected {
            let retained = try await view.evaluateJavaScript("window.sessionToken") as? String
            let counter = try await view.evaluateJavaScript("window.counter") as? Int
            XCTAssertEqual(retained, token)
            XCTAssertEqual(counter, 5)
        }
        let updatedCounter = try await selected.evaluateJavaScript("window.counter") as? Int
        XCTAssertEqual(updatedCounter, 100)
        XCTAssertEqual(surface.topologyEpoch, originalEpoch)
        surface.paneLayout = .leaf(1) // Independently authorized pane close/replacement.
        surface.panesById.removeValue(forKey: 3)
        let closed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            selection.paneId == nil
        }, object: nil)
        await fulfillment(of: [closed], timeout: 5)
        XCTAssertNil(selection.paneId)
        XCTAssertEqual(surface.paneLayout.paneIDs, [1], "Restore must not replay the old tree")
        selection.paneId = 1
        surface.topologyEpoch += 1
        let replaced = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            selection.paneId == nil
        }, object: nil)
        await fulfillment(of: [replaced], timeout: 5)
        XCTAssertNil(selection.paneId, "external topology revision ends the presentation")
    }

    @MainActor
    private func waitForPopoutFrame(_ view: WKWebView, in window: UIWindow,
                                   expected: CGRect) async {
        let resized = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            let actual = view.convert(view.bounds, to: window)
            return abs(actual.minX - expected.minX) < 1 && abs(actual.minY - expected.minY) < 1
                && abs(actual.width - expected.width) < 1 && abs(actual.height - expected.height) < 1
        }, object: nil)
        await fulfillment(of: [resized], timeout: 5)
        let actual = view.convert(view.bounds, to: window)
        XCTAssertEqual(actual.minX, expected.minX, accuracy: 1)
        XCTAssertEqual(actual.minY, expected.minY, accuracy: 1)
        XCTAssertEqual(actual.width, expected.width, accuracy: 1)
        XCTAssertEqual(actual.height, expected.height, accuracy: 1)
    }

    @MainActor
    private func assertPopoutGlyphPaints(_ button: UIButton, state: String) throws {
        button.layoutIfNeeded()
        let imageView = try XCTUnwrap(button.imageView)
        XCTAssertNotNil(imageView.image, "\(state): the symbol must resolve")
        XCTAssertFalse(imageView.isHidden)
        XCTAssertGreaterThan(imageView.bounds.width, 0)
        let imageIndex = try XCTUnwrap(button.subviews.firstIndex(of: imageView))
        let materialIndex = try XCTUnwrap(button.subviews.firstIndex { $0 is UIVisualEffectView })
        print("popout_glyph state=\(state) image_index=\(imageIndex) material_index=\(materialIndex) image_frame=\(imageView.frame)")
        XCTAssertGreaterThan(imageIndex, materialIndex, "material must not occlude the glyph")

        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let renderer = UIGraphicsImageRenderer(bounds: button.bounds, format: format)
        func capture() -> UIImage {
            renderer.image { _ in
                XCTAssertTrue(button.drawHierarchy(in: button.bounds, afterScreenUpdates: true))
            }
        }
        let visible = capture()
        imageView.isHidden = true
        let withoutGlyph = capture()
        imageView.isHidden = false
        let visibleAttachment = XCTAttachment(image: visible)
        visibleAttachment.name = "popout-\(state)-visible"
        visibleAttachment.lifetime = .keepAlways
        add(visibleAttachment)
        let backgroundAttachment = XCTAttachment(image: withoutGlyph)
        backgroundAttachment.name = "popout-\(state)-without-glyph"
        backgroundAttachment.lifetime = .keepAlways
        add(backgroundAttachment)
        let visiblePixels = try rgbaPixels(visible)
        let backgroundPixels = try rgbaPixels(withoutGlyph)
        XCTAssertEqual(visiblePixels.count, backgroundPixels.count)
        let paintedPixels = stride(from: 0, to: min(visiblePixels.count, backgroundPixels.count), by: 4)
            .filter { offset in
                // Black light-mode symbols change alpha over a transparent
                // material snapshot; RGB alone cannot detect their ink.
                (0..<4).contains { channel in
                    abs(Int(visiblePixels[offset + channel]) - Int(backgroundPixels[offset + channel])) > 20
                }
            }.count
        print("popout_glyph state=\(state) painted_pixels=\(paintedPixels)")
        XCTAssertGreaterThan(paintedPixels, 8,
                             "\(state): the actual render must contain a visible glyph over the material")
    }

    @MainActor
    private func rgbaPixels(_ image: UIImage) throws -> [UInt8] {
        let cgImage = try XCTUnwrap(image.cgImage)
        var pixels = [UInt8](repeating: 0, count: cgImage.width * cgImage.height * 4)
        try pixels.withUnsafeMutableBytes { bytes in
            let context = try XCTUnwrap(CGContext(
                data: bytes.baseAddress, width: cgImage.width, height: cgImage.height,
                bitsPerComponent: 8, bytesPerRow: cgImage.width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
            context.draw(cgImage, in: CGRect(x: 0, y: 0, width: CGFloat(cgImage.width), height: CGFloat(cgImage.height)))
        }
        return pixels
    }

    @MainActor
    private func popoutToolbarButtons(in view: UIView) -> [UIButton] {
        (view as? UIButton).map { [$0] }
            ?? view.subviews.flatMap { popoutToolbarButtons(in: $0) }
    }

    @MainActor
    private func popoutWebViews(in view: UIView) -> [WKWebView] {
        (view as? WKWebView).map { [$0] } ?? view.subviews.flatMap { popoutWebViews(in: $0) }
    }

    @MainActor
    private func waitForMountedWebViews(_ expected: [WKWebView], in root: UIView) async {
        let expectedIds = Set(expected.map(ObjectIdentifier.init))
        let mounted = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            Set(self.popoutWebViews(in: root).map(ObjectIdentifier.init)) == expectedIds
        }, object: nil)
        await fulfillment(of: [mounted], timeout: 5)
        XCTAssertEqual(Set(popoutWebViews(in: root).map(ObjectIdentifier.init)), expectedIds)
    }

    @MainActor
    private func popoutSessionTokens(_ views: [WKWebView]) async throws -> [String] {
        var result: [String] = []
        for view in views {
            let token = try await view.evaluateJavaScript("window.sessionToken") as? String
            result.append(try XCTUnwrap(token))
        }
        return result
    }

    func testLocalResizePreviewCancelsAndNeverReplaysAcrossRevisionOrRestart() {
        var preview = SurfAceSplitPreviewState()
        let interruptedToken = UUID()
        preview.update(weights: [1.5, 0.5], token: interruptedToken, topologyEpoch: 7)
        XCTAssertEqual(preview.visibleWeights(count: 2, topologyEpoch: 7), [1.5, 0.5])
        XCTAssertNil(preview.visibleWeights(count: 2, topologyEpoch: 8))
        XCTAssertNil(preview.completedWeights(token: interruptedToken, topologyEpoch: 8))

        preview.cancel(token: interruptedToken)
        XCTAssertNil(preview.visibleWeights(count: 2, topologyEpoch: 7))
        XCTAssertNil(preview.completedWeights(token: interruptedToken, topologyEpoch: 7))

        let nextToken = UUID()
        preview.update(weights: [1.2, 0.8], token: nextToken, topologyEpoch: 8)
        preview.cancel(token: interruptedToken) // A delayed callback cannot erase the next drag.
        XCTAssertEqual(preview.completedWeights(token: nextToken, topologyEpoch: 8)?.weights, [1.2, 0.8])

        // A completed drag A remains eligible while a newer displayed drag B
        // starts and cancels; the pending end request is not the view preview.
        preview.queueCommit(token: nextToken)
        let newerToken = UUID()
        preview.update(weights: [1.3, 0.7], token: newerToken, topologyEpoch: 8)
        preview.cancel(token: newerToken)
        XCTAssertTrue(preview.mayCommit(token: nextToken))
        preview.finishCommit(token: nextToken)
        XCTAssertFalse(preview.mayCommit(token: nextToken))

        preview.update(weights: [1.4, 0.6], token: newerToken, topologyEpoch: 8)
        preview.queueCommit(token: newerToken)
        preview.cancelAll() // Scene interruption invalidates every queued end.
        XCTAssertFalse(preview.mayCommit(token: newerToken))

        // Process recreation has no preview state to replay; durable topology
        // comes from the generation store, exercised by the restart test below.
        preview = SurfAceSplitPreviewState()
        XCTAssertNil(preview.visibleWeights(count: 2, topologyEpoch: 8))
    }

    func testPaneLayoutIdentityIgnoresWeightOnlyChanges() {
        let initial = SurfAcePaneLayoutNode.split(
            direction: .vertical,
            children: [
                .leaf(1, weight: 1),
                .split(direction: .horizontal, children: [.leaf(2, weight: 1), .leaf(3, weight: 1)], weight: 1),
            ],
            weight: 1
        )
        let resized = initial.updatingSplitWeights(path: [], weights: [1.5, 0.5])
        let nestedResized = initial.updatingSplitWeights(path: [1], weights: [1.75, 0.25])

        XCTAssertEqual(resized.layoutIdentity, initial.layoutIdentity)
        XCTAssertEqual(nestedResized.layoutIdentity, initial.layoutIdentity)
    }

    @MainActor
    func testResizeSplitDeltaPreservesPairTotalAtMinimumClamp() {
        let runtime = SurfAceRuntime()
        let surface = runtime.registerSurface(sceneKey: "resize-clamp")
        surface.panesById = [
            1: SurfAcePaneModel(paneId: 1, paneLabel: 1),
            2: SurfAcePaneModel(paneId: 2, paneLabel: 2),
            3: SurfAcePaneModel(paneId: 3, paneLabel: 3),
            4: SurfAcePaneModel(paneId: 4, paneLabel: 4),
        ]
        surface.paneLayout = .split(
            direction: .vertical,
            children: [
                .leaf(1, weight: 10),
                .leaf(2, weight: 0.6),
                .leaf(3, weight: 0.6),
                .leaf(4, weight: 10),
            ]
        )

        runtime.resizeSplit(surfaceId: surface.surfaceId, path: [], childIndex: 1, delta: 200, extent: 200)

        guard case .split(_, let children, _) = surface.paneLayout else {
            return XCTFail("Expected split layout after resize")
        }
        XCTAssertEqual(children[1].layoutWeight + children[2].layoutWeight, 1.2, accuracy: 0.0001)
    }

    @MainActor
    func testResizeSplitAppliesAbsoluteWeightsAndBumpsTopologyEpoch() {
        let runtime = SurfAceRuntime()
        let surface = runtime.registerSurface(sceneKey: "resize-weights")
        surface.panesById = [
            1: SurfAcePaneModel(paneId: 1, paneLabel: 1),
            2: SurfAcePaneModel(paneId: 2, paneLabel: 2),
        ]
        surface.paneLayout = .split(direction: .vertical, children: [.leaf(1, weight: 1), .leaf(2, weight: 1)])
        surface.topologyEpoch = 3

        runtime.resizeSplit(surfaceId: surface.surfaceId, path: [], weights: [1.4, 0.6])

        guard case .split(_, let children, _) = surface.paneLayout else {
            return XCTFail("Expected split layout after resize")
        }
        XCTAssertEqual(children.map(\.layoutWeight), [1.4, 0.6])
        XCTAssertEqual(surface.topologyEpoch, 4)
    }

    @MainActor
    func testLocklessResizeCommitsProjectsAndSurvivesRestart() async throws {
        let suiteName = "SurfAceResizeCommit.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defaults.removePersistentDomain(forName: suiteName)
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(suiteName, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock {
            defaults.removePersistentDomain(forName: suiteName)
            try? FileManager.default.removeItem(at: directory)
        }
        let stateURL = directory.appendingPathComponent("authority-v1.json")
        let runtime = SurfAceRuntime(
            userDefaults: defaults, locklessStateURL: stateURL,
            enableFleetDiscovery: false, isolatedTestLoopback: true
        )
        await runtime.restoreLocklessAuthority(reason: "resize-test")
        let registered = await runtime.registerSurfaceForScene(sceneKey: suiteName)
        let surface = try XCTUnwrap(registered)
        let surfaceId = surface.surfaceId
        let adapter = try runtime.locklessAuthorityForLocalMutation()
        _ = try await adapter.commitLocalMutation(operation: "test.resize.split") { state, _ in
            let split = try TestRegistryTopology.paneSplit(
                state: &state, surfaceId: surfaceId, paneId: 1,
                count: 2, direction: "vertical",
                expectedTopologyRevision: state.liveSurfaces[surfaceId]?.topologyRevision ?? -1
            )
            return .integer(split.newPaneIds[0])
        }
        await runtime.restoreLocklessAuthority(reason: "resize-test-split")
        guard case .split(_, let initialChildren, _) = surface.paneLayout else {
            return XCTFail("Expected projected split before resize")
        }
        XCTAssertEqual(initialChildren.map(\.layoutWeight), [1, 1])

        let generationBefore = (await adapter.snapshot()).generation
        runtime.resizeSplit(surfaceId: surfaceId, path: [], weights: [1.4, 0.6])
        var committed = false
        for _ in 0..<100 {
            let state = await adapter.snapshot()
            if state.generation > generationBefore,
               case .split(_, let children, _) = surface.paneLayout,
               abs(children[0].layoutWeight - 1.4) < 0.001 {
                committed = true
                break
            }
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        let after = await adapter.snapshot()
        XCTAssertTrue(
            committed,
            "Resize must commit and project back into the visible tree; generation \(generationBefore)->\(after.generation), endpointError=\(runtime.endpointError ?? "none"), topology=\(after.liveSurfaces[surfaceId]?.topology ?? .null)"
        )
        let committedSurface = try XCTUnwrap(after.liveSurfaces[surfaceId])
        let committedRecord = try XCTUnwrap(after.scopes["surface:\(surfaceId)"]?.records.last)
        XCTAssertEqual(committedRecord.recordClass, .topology)
        guard case .object(let event) = committedRecord.payload else {
            return XCTFail("Expected committed topology record payload")
        }
        XCTAssertEqual(event["topology"], committedSurface.topology)
        XCTAssertEqual(event["topologyRevision"], .integer(committedSurface.topologyRevision))

        // Force the generation store's atomic temporary write to fail. Neither
        // memory nor disk may report the uncommitted resize as successful.
        let blockedTemporaryURL = directory.appendingPathComponent(".authority-v1.json.next", isDirectory: true)
        try FileManager.default.createDirectory(at: blockedTemporaryURL, withIntermediateDirectories: true)
        let beforeFailedSave = await adapter.snapshot()
        let failedSave = expectation(description: "failed resize save completed")
        runtime.resizeSplit(surfaceId: surfaceId, path: [], weights: [1.25, 0.75]) { failedSave.fulfill() }
        await fulfillment(of: [failedSave], timeout: 5)
        XCTAssertNotNil(runtime.endpointError)
        XCTAssertTrue(runtime.resizeSaveFailures.contains(surfaceId))
        let afterFailedSave = await adapter.snapshot()
        XCTAssertEqual(afterFailedSave, beforeFailedSave)
        XCTAssertEqual(try SurfAceLocklessGenerationStore(stateURL: stateURL).load(), beforeFailedSave)
        guard case .split(_, let afterFailedSaveChildren, _) = surface.paneLayout else {
            return XCTFail("Expected last committed split after failed save")
        }
        XCTAssertEqual(afterFailedSaveChildren.map(\.layoutWeight), [1.4, 0.6])
        try FileManager.default.removeItem(at: blockedTemporaryURL)

        let recoveredSave = expectation(description: "recovered resize save completed")
        runtime.resizeSplit(surfaceId: surfaceId, path: [], weights: [1.25, 0.75]) { recoveredSave.fulfill() }
        await fulfillment(of: [recoveredSave], timeout: 5)
        XCTAssertFalse(runtime.resizeSaveFailures.contains(surfaceId))
        let restorePriorWeights = expectation(description: "restore original committed weights")
        runtime.resizeSplit(surfaceId: surfaceId, path: [], weights: [1.4, 0.6]) { restorePriorWeights.fulfill() }
        await fulfillment(of: [restorePriorWeights], timeout: 5)

        let restarted = SurfAceRuntime(
            userDefaults: defaults, locklessStateURL: stateURL,
            enableFleetDiscovery: false, isolatedTestLoopback: true
        )
        await restarted.restoreLocklessAuthority(reason: "resize-test-restart")
        let restored = await restarted.registerSurfaceForScene(sceneKey: suiteName)
        let restoredSurface = try XCTUnwrap(restored)
        guard case .split(_, let restoredChildren, _) = restoredSurface.paneLayout else {
            return XCTFail("Expected split after restart")
        }
        XCTAssertEqual(restoredChildren.map(\.layoutWeight), [1.4, 0.6])

        let restartedAdapter = try restarted.locklessAuthorityForLocalMutation()
        let changeAndReturnRevision = (await restartedAdapter.snapshot()).liveSurfaces[surfaceId]?.topologyRevision ?? -1
        let changed = expectation(description: "first queued resize completed")
        let returned = expectation(description: "return to original weights completed")
        restarted.resizeSplit(surfaceId: surfaceId, path: [], weights: [1.2, 0.8]) { changed.fulfill() }
        restarted.resizeSplit(surfaceId: surfaceId, path: [], weights: [1.4, 0.6]) { returned.fulfill() }
        await fulfillment(of: [changed, returned], timeout: 5)
        let changeAndReturnActual = (await restartedAdapter.snapshot()).liveSurfaces[surfaceId]?.topologyRevision
        XCTAssertEqual(changeAndReturnActual, changeAndReturnRevision + 2)
        guard case .split(_, let returnedChildren, _) = restoredSurface.paneLayout else {
            return XCTFail("Expected projected split after change and return")
        }
        XCTAssertEqual(returnedChildren.map(\.layoutWeight), [1.4, 0.6])

        let beforeRepeatedResize = await restartedAdapter.snapshot()
        let repeatedRevision = beforeRepeatedResize.liveSurfaces[surfaceId]?.topologyRevision ?? -1
        let repeatedRecordCount = beforeRepeatedResize.scopes["surface:\(surfaceId)"]?.records.count ?? -1
        let repeatedFirst = expectation(description: "first repeated resize completed")
        let repeatedSecond = expectation(description: "second repeated resize completed")
        restarted.resizeSplit(surfaceId: surfaceId, path: [], weights: [1.3, 0.7]) { repeatedFirst.fulfill() }
        restarted.resizeSplit(surfaceId: surfaceId, path: [], weights: [1.3, 0.7]) { repeatedSecond.fulfill() }
        await fulfillment(of: [repeatedFirst, repeatedSecond], timeout: 5)
        let afterRepeatedResize = await restartedAdapter.snapshot()
        let repeatedActual = afterRepeatedResize.liveSurfaces[surfaceId]?.topologyRevision
        XCTAssertEqual(repeatedActual, repeatedRevision + 1)
        XCTAssertEqual(afterRepeatedResize.scopes["surface:\(surfaceId)"]?.records.count, repeatedRecordCount + 1)

        // Scene interruption after gesture end can arrive while that end
        // request waits behind an earlier durable commit and event fanout.
        // The interrupted request must not make a second topology record.
        let beforeInterruptedResize = await restartedAdapter.snapshot()
        let firstQueuedEnd = expectation(description: "first resize end completed")
        let interruptedEnd = expectation(description: "interrupted resize end completed")
        var sceneStillActive = true
        restarted.resizeSplit(surfaceId: surfaceId, path: [], weights: [1.15, 0.85]) {
            firstQueuedEnd.fulfill()
        }
        restarted.resizeSplit(
            surfaceId: surfaceId, path: [], weights: [1.1, 0.9],
            shouldCommit: { sceneStillActive }
        ) {
            interruptedEnd.fulfill()
        }
        sceneStillActive = false
        await fulfillment(of: [firstQueuedEnd, interruptedEnd], timeout: 5)
        let afterInterruptedResize = await restartedAdapter.snapshot()
        XCTAssertEqual(afterInterruptedResize.generation, beforeInterruptedResize.generation + 1)
        XCTAssertEqual(
            afterInterruptedResize.liveSurfaces[surfaceId]?.topologyRevision,
            (beforeInterruptedResize.liveSurfaces[surfaceId]?.topologyRevision ?? -1) + 1
        )
        XCTAssertEqual(
            afterInterruptedResize.scopes["surface:\(surfaceId)"]?.records.count,
            (beforeInterruptedResize.scopes["surface:\(surfaceId)"]?.records.count ?? -1) + 1
        )
        guard case .split(_, let afterInterruptedChildren, _) = restoredSurface.paneLayout else {
            return XCTFail("Expected first end commit to remain visible")
        }
        XCTAssertEqual(afterInterruptedChildren.map(\.layoutWeight), [1.15, 0.85])

        // An unrelated/new preview must not revoke completed A while A waits
        // behind a predecessor. Only explicit interruption revokes A.
        let beforeOverlappingGestures = await restartedAdapter.snapshot()
        let predecessorEnd = expectation(description: "predecessor no-op completed")
        let completedA = expectation(description: "completed A committed")
        var pending = SurfAceSplitPreviewState()
        let tokenA = UUID()
        let tokenB = UUID()
        pending.update(weights: [1.18, 0.82], token: tokenA, topologyEpoch: Int(beforeOverlappingGestures.liveSurfaces[surfaceId]?.topologyRevision ?? -1))
        pending.queueCommit(token: tokenA)
        restarted.resizeSplit(surfaceId: surfaceId, path: [], weights: [1.15, 0.85]) {
            predecessorEnd.fulfill()
        }
        restarted.resizeSplit(
            surfaceId: surfaceId, path: [], weights: [1.18, 0.82],
            shouldCommit: { pending.mayCommit(token: tokenA) }
        ) {
            pending.finishCommit(token: tokenA)
            completedA.fulfill()
        }
        pending.update(weights: [1.25, 0.75], token: tokenB, topologyEpoch: pending.topologyEpoch ?? -1)
        pending.cancel(token: tokenB)
        await fulfillment(of: [predecessorEnd, completedA], timeout: 5)
        let afterOverlappingGestures = await restartedAdapter.snapshot()
        XCTAssertEqual(afterOverlappingGestures.generation, beforeOverlappingGestures.generation + 1)
        XCTAssertEqual(
            afterOverlappingGestures.liveSurfaces[surfaceId]?.topologyRevision,
            (beforeOverlappingGestures.liveSurfaces[surfaceId]?.topologyRevision ?? -1) + 1
        )
        XCTAssertFalse(pending.mayCommit(token: tokenA))

        let afterFailureRevision = (await restartedAdapter.snapshot()).liveSurfaces[surfaceId]?.topologyRevision ?? -1
        let failed = expectation(description: "invalid predecessor completed")
        let recovered = expectation(description: "valid successor completed")
        restarted.resizeSplit(surfaceId: surfaceId, path: [], weights: [.nan, 0.7]) { failed.fulfill() }
        restarted.resizeSplit(surfaceId: surfaceId, path: [], weights: [1.2, 0.8]) { recovered.fulfill() }
        await fulfillment(of: [failed, recovered], timeout: 5)
        let afterFailureActual = (await restartedAdapter.snapshot()).liveSurfaces[surfaceId]?.topologyRevision
        XCTAssertEqual(afterFailureActual, afterFailureRevision + 1)
        guard case .split(_, let recoveredChildren, _) = restoredSurface.paneLayout else {
            return XCTFail("Expected projected split after invalid predecessor")
        }
        XCTAssertEqual(recoveredChildren.map(\.layoutWeight), [1.2, 0.8])

        // Another commit to the same split leaves its structural identity
        // unchanged. A drag based on the older revision must still fail closed.
        let beforeCompetingResize = await restartedAdapter.snapshot()
        let competingRevision = try XCTUnwrap(beforeCompetingResize.liveSurfaces[surfaceId]?.topologyRevision)
        let competingIdentity = restoredSurface.paneLayout.layoutIdentity
        _ = try await restartedAdapter.commitLocalResize(
            surfaceId: surfaceId, path: [], weights: [1.35, 0.65],
            expectedSplitIdentity: competingIdentity,
            expectedTopologyRevision: competingRevision
        )
        let afterCompetingResize = await restartedAdapter.snapshot()
        do {
            _ = try await restartedAdapter.commitLocalResize(
                surfaceId: surfaceId, path: [], weights: [1.4, 0.6],
                expectedSplitIdentity: competingIdentity,
                expectedTopologyRevision: competingRevision
            )
            XCTFail("A stale gesture must not replace newer weights on the same split")
        } catch {
            let afterStaleWeights = await restartedAdapter.snapshot()
            XCTAssertEqual(afterStaleWeights, afterCompetingResize)
        }
        await restarted.restoreLocklessAuthority(reason: "resize-test-competing-weights")

        let supersededRootIdentity = restoredSurface.paneLayout.layoutIdentity
        _ = try await restartedAdapter.commitLocalMutation(operation: "test.resize.nested_split") { state, _ in
            let split = try TestRegistryTopology.paneSplit(
                state: &state, surfaceId: surfaceId, paneId: 1,
                count: 2, direction: "horizontal",
                expectedTopologyRevision: state.liveSurfaces[surfaceId]?.topologyRevision ?? -1
            )
            return .integer(split.newPaneIds[0])
        }
        await restarted.restoreLocklessAuthority(reason: "resize-test-nested-split")
        let beforeStaleResize = await restartedAdapter.snapshot()
        do {
            _ = try await restartedAdapter.commitLocalResize(
                surfaceId: surfaceId, path: [], weights: [1.6, 0.4],
                expectedSplitIdentity: supersededRootIdentity
            )
            XCTFail("A superseded split identity must refuse stale preview commit")
        } catch {
            let afterStaleResize = await restartedAdapter.snapshot()
            XCTAssertEqual(afterStaleResize, beforeStaleResize)
        }
        let nestedRevision = (await restartedAdapter.snapshot()).liveSurfaces[surfaceId]?.topologyRevision ?? -1
        let nestedDone = expectation(description: "nested resize completed")
        let rootDone = expectation(description: "root resize completed")
        restarted.resizeSplit(surfaceId: surfaceId, path: [0], weights: [1.3, 0.7]) { nestedDone.fulfill() }
        restarted.resizeSplit(surfaceId: surfaceId, path: [], weights: [1.1, 0.9]) { rootDone.fulfill() }
        await fulfillment(of: [nestedDone, rootDone], timeout: 5)
        let nestedActual = (await restartedAdapter.snapshot()).liveSurfaces[surfaceId]?.topologyRevision
        XCTAssertEqual(nestedActual, nestedRevision + 2)
        guard case .split(_, let rootChildren, _) = restoredSurface.paneLayout,
              case .split(_, let nestedChildren, _) = rootChildren[0] else {
            return XCTFail("Expected nested projected split after two different resize paths")
        }
        XCTAssertEqual(rootChildren.map(\.layoutWeight), [1.1, 0.9])
        XCTAssertEqual(nestedChildren.map(\.layoutWeight), [1.3, 0.7])
    }

    func testKeyboardFocusOutlineIsSuppressedForSinglePaneSurfaces() {
        XCTAssertFalse(surfAceShowsKeyboardFocusOutline(activePaneId: 1, paneId: 1, paneCount: 1))
        XCTAssertFalse(surfAceShowsKeyboardFocusOutline(activePaneId: nil, paneId: 1, paneCount: 1))
    }

    func testKeyboardFocusOutlineShowsOnlyForActivePaneWhenMultiplePanesExist() {
        XCTAssertTrue(surfAceShowsKeyboardFocusOutline(activePaneId: 2, paneId: 2, paneCount: 2))
        XCTAssertFalse(surfAceShowsKeyboardFocusOutline(activePaneId: 2, paneId: 1, paneCount: 2))
    }

    func testKeyboardFocusBandUsesTwentyPointSpecThickness() {
        XCTAssertEqual(surfAceKeyboardFocusBandWidth(), 20)
    }

    @MainActor
    func testPaneLabelTextUsesVisiblePaneLabelNotOptionalName() {
        let pane = SurfAcePaneModel(paneId: 9, paneLabel: 42, name: "Right")

        XCTAssertEqual(pane.labelText, "42")
        XCTAssertEqual(pane.displayId(windowLabel: "c"), "42")
        XCTAssertEqual(pane.visibleAddress(windowLabel: "c"), "42")
        XCTAssertFalse(pane.displayId(windowLabel: "c").contains("c"))
    }

    @MainActor
    func testUnassignedPaneHasNoGuessedNumberWhileWindowLabelRemainsVisibleOffline() {
        let surface = SurfAceSurfaceModel(sceneKey: "scene-unassigned", surfaceId: "sf_unassigned", windowLabel: "g", name: "Surf Ace")
        let pane = SurfAcePaneModel(paneId: 901, paneLabel: 0, name: "Unnumbered")
        surface.connectionBarState = .disconnected

        let identity = surfAcePaneChromeIdentityParts(surface: surface, pane: pane)

        XCTAssertEqual(identity.windowLabel, "g")
        XCTAssertEqual(identity.displayId, "")
        XCTAssertTrue(surfAcePaneChromeShowsIdentityLabels(connectionState: surface.connectionBarState))
    }

    @MainActor
    func testPaneChromeIdentityUsesGlobalPaneTokenAndWindowLabelOnly() {
        let surface = SurfAceSurfaceModel(sceneKey: "scene-chrome", surfaceId: "sf_chrome", windowLabel: "c", name: "Surf Ace")
        let pane = SurfAcePaneModel(paneId: 9, paneLabel: 42, name: "Right")
        pane.currentEntry = SurfAcePaneEntry(
            contentId: "ct_chrome",
            revision: 1,
            historyOwnerToken: "hot_chrome",
            contentType: .markdown,
            payload: .markdown(markdown: "# Chrome"),
            title: "Document Title",
            provenanceDisplayName: "Session One",
            scrollable: true,
            interactive: true,
            url: nil,
            drawingData: Data(),
            strokesById: [:]
        )

        let identity = surfAcePaneChromeIdentityParts(surface: surface, pane: pane)

        XCTAssertEqual(identity.displayId, "42")
        XCTAssertEqual(identity.windowLabel, "c")
        XCTAssertEqual(pane.currentChromeDisplayName(), "Session One")
        XCTAssertFalse(identity.displayId.contains(identity.windowLabel))
        XCTAssertNotEqual(identity.displayId, "c42")
        XCTAssertNotEqual(identity.displayId, "c-42")
        XCTAssertNotEqual(identity.displayId, "e1")
        XCTAssertNotEqual(identity.displayId, "e16")
        XCTAssertNotEqual(identity.displayId, "b13")
    }

    @MainActor
    func testSpatialPaneIdentityUsesSharedInsetAndBaselineAlignment() {
        XCTAssertEqual(
            surfAcePaneIdentityChromeInset(bundleIdentifier: "co.clicketyclacks.SurfAce.spatial"),
            surfAcePaneIdentityChromeInset(bundleIdentifier: "co.clicketyclacks.SurfAce")
        )
        XCTAssertEqual(surfAceSpatialIdentityDepthOffsetValue(), 56)
        XCTAssertEqual(surfAceSpatialChromeDepthOffsetValue(), 0)
    }

    @MainActor
    func testPaneChromeIdentityDoesNotUseContentTitleAsSessionName() {
        let surface = SurfAceSurfaceModel(sceneKey: "scene-chrome-title", surfaceId: "sf_chrome_title", windowLabel: "e", name: "Surf Ace")
        let pane = SurfAcePaneModel(paneId: 16, paneLabel: 99, name: "Right")
        pane.currentEntry = SurfAcePaneEntry(
            contentId: "ct_chrome_title",
            revision: 1,
            historyOwnerToken: "hot_chrome_title",
            contentType: .markdown,
            payload: .markdown(markdown: "# Chrome"),
            title: "Document Title",
            provenanceDisplayName: nil,
            scrollable: true,
            interactive: true,
            url: nil,
            drawingData: Data(),
            strokesById: [:]
        )

        let identity = surfAcePaneChromeIdentityParts(surface: surface, pane: pane)

        XCTAssertEqual(identity.displayId, "99")
        XCTAssertEqual(identity.windowLabel, "e")
        XCTAssertEqual(pane.currentOwnerDisplayName(), "Document Title")
        XCTAssertNil(pane.currentChromeDisplayName())
        XCTAssertNotEqual(identity.displayId, "e16")
    }

    @MainActor
    func testPaneChromeIdentityUsesProvenanceSessionKeyWhenDisplayNameIsAbsent() {
        let surface = SurfAceSurfaceModel(sceneKey: "scene-chrome-session-key", surfaceId: "sf_chrome_session_key", windowLabel: "f", name: "Surf Ace")
        let pane = SurfAcePaneModel(paneId: 17, paneLabel: 100, name: "Right")
        pane.currentEntry = SurfAcePaneEntry(
            contentId: "ct_chrome_key",
            revision: 1,
            historyOwnerToken: "hot_chrome_key",
            contentType: .markdown,
            payload: .markdown(markdown: "# Chrome"),
            title: "Document Title",
            provenanceDisplayName: nil,
            provenanceSessionKey: "agent:test:session-only",
            scrollable: true,
            interactive: true,
            url: nil,
            drawingData: Data(),
            strokesById: [:]
        )

        let identity = surfAcePaneChromeIdentityParts(surface: surface, pane: pane)

        XCTAssertEqual(identity.displayId, "100")
        XCTAssertEqual(identity.windowLabel, "f")
        XCTAssertEqual(pane.currentOwnerDisplayName(), "Document Title")
        XCTAssertEqual(pane.currentChromeDisplayName(), "agent:test:session-only")
    }

    @MainActor
    func testRegisterSurfaceRestoresPersistedPaneTopologyAfterRelaunch() {
        let suiteName = "SurfAceSurfaceTopologyPersistenceTests.\(UUID().uuidString)"
        guard let userDefaults = UserDefaults(suiteName: suiteName) else {
            XCTFail("Expected isolated UserDefaults suite")
            return
        }
        userDefaults.removePersistentDomain(forName: suiteName)
        defer {
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let firstRuntime = SurfAceRuntime(userDefaults: userDefaults)
        let firstSurface = firstRuntime.registerSurface(sceneKey: "scene-1")
        firstSurface.windowLabel = "a"
        firstSurface.name = "Surf Ace A"
        firstSurface.panesById = [
            1: SurfAcePaneModel(paneId: 1, paneLabel: 1, name: "One"),
            2: SurfAcePaneModel(paneId: 2, paneLabel: 2, name: "Two"),
            3: SurfAcePaneModel(paneId: 3, paneLabel: 3, name: "Three"),
        ]
        firstSurface.paneLayout = .split(direction: .horizontal, children: [.leaf(1), .leaf(2), .leaf(3)])
        firstSurface.activeKeyboardPaneId = 2
        firstSurface.providerTopologyInitialized = true
        firstRuntime.persistSurfaceTopology(surfaceId: firstSurface.surfaceId)

        let relaunchedRuntime = SurfAceRuntime(userDefaults: userDefaults)
        let restoredSurface = relaunchedRuntime.registerSurface(sceneKey: "scene-1")

        XCTAssertEqual(restoredSurface.surfaceId, firstSurface.surfaceId)
        XCTAssertEqual(restoredSurface.windowLabel, "a")
        XCTAssertEqual(restoredSurface.name, "Surf Ace A")
        XCTAssertEqual(restoredSurface.paneLayout.paneIDs, [1, 2, 3])
        XCTAssertEqual(restoredSurface.activeKeyboardPaneId, 1)
        XCTAssertEqual(restoredSurface.panes.map(\.paneLabel), [1, 2, 3])
        XCTAssertEqual(restoredSurface.panes.map(\.name), ["One", "Two", "Three"])
        XCTAssertTrue(restoredSurface.providerTopologyInitialized)
    }

    @MainActor
    func testRegisterSurfaceRestoresPersistedPaneContentHistoryAndTargetStateAfterRelaunch() {
        let suiteName = "SurfAceSurfaceTopologyPersistenceTests.\(UUID().uuidString)"
        guard let userDefaults = UserDefaults(suiteName: suiteName) else {
            XCTFail("Expected isolated UserDefaults suite")
            return
        }
        userDefaults.removePersistentDomain(forName: suiteName)
        defer {
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let firstRuntime = SurfAceRuntime(userDefaults: userDefaults)
        let firstSurface = firstRuntime.registerSurface(sceneKey: "scene-content")
        let pane = SurfAcePaneModel(paneId: 1, paneLineageId: "pl_content", paneLabel: 1, name: "Browser")
        pane.backStack = [
            SurfAcePaneEntry.empty(revision: 1),
        ]
        pane.currentEntry = .browserURL(
            targetId: "tg_browser",
            targetEpoch: 2,
            url: "https://example.com/docs#intro",
            title: "Docs"
        )
        pane.forwardStack = [
            SurfAcePaneEntry.empty(revision: 3),
        ]
        pane.currentTarget = SurfAcePaneTargetState(
            targetId: "tg_browser",
            targetKind: "browser_url",
            paneLineageId: "pl_content",
            targetEpoch: 2,
            restorePolicy: "auto",
            currentState: "applied",
            targetHeader: [
                "summary": "https://example.com/docs#intro",
                "requiredCapabilities": ["target.browser_url.v1"],
                "safetyClass": "network",
                "replaySemantics": "navigate",
                "payloadSchemaVersion": 1,
                "safeToLogFields": ["url"],
            ],
            targetPayload: ["url": "https://example.com/docs#intro"],
            lastApplyEvidence: [
                "status": "applied",
                "targetId": "tg_browser",
                "targetEpoch": 2,
                "materializedState": [
                    "navigationStatus": "loaded",
                    "replaySemantics": "navigate",
                    "url": "https://example.com/docs#intro",
                ],
            ]
        )
        firstSurface.windowLabel = "a"
        firstSurface.panesById = [1: pane]
        firstSurface.paneLayout = .leaf(1)
        firstSurface.providerTopologyInitialized = true
        firstRuntime.persistSurfaceTopology(surfaceId: firstSurface.surfaceId)

        let relaunchedRuntime = SurfAceRuntime(userDefaults: userDefaults)
        let restoredSurface = relaunchedRuntime.registerSurface(sceneKey: "scene-content")
        let restoredPane = restoredSurface.panes.first

        XCTAssertEqual(restoredSurface.surfaceId, firstSurface.surfaceId)
        XCTAssertEqual(restoredPane?.paneLineageId, "pl_content")
        XCTAssertEqual(restoredPane?.currentEntry.url, "https://example.com/docs#intro")
        XCTAssertEqual(restoredPane?.currentEntry.revision, 2)
        XCTAssertEqual(restoredPane?.currentEntry.title, "Docs")
        XCTAssertEqual(restoredPane?.backStack.map(\.revision), [1])
        XCTAssertEqual(restoredPane?.forwardStack.map(\.revision), [3])
        XCTAssertEqual(restoredPane?.currentTarget?.targetId, "tg_browser")
        XCTAssertEqual(restoredPane?.currentTarget?.targetKind, "browser_url")
        XCTAssertEqual(restoredPane?.currentTarget?.targetHeader?["summary"] as? String, "https://example.com/docs#intro")
        XCTAssertEqual(
            restoredPane?.currentTarget?.targetHeader?["requiredCapabilities"] as? [String],
            ["target.browser_url.v1"]
        )
        XCTAssertEqual(restoredPane?.currentTarget?.targetPayload?["url"] as? String, "https://example.com/docs#intro")
        XCTAssertEqual(restoredPane?.currentTarget?.lastApplyEvidence?["status"] as? String, "applied")
        let materializedState = restoredPane?.currentTarget?.lastApplyEvidence?["materializedState"] as? [String: Any]
        XCTAssertEqual(materializedState?["navigationStatus"] as? String, "loaded")
        XCTAssertEqual(materializedState?["url"] as? String, "https://example.com/docs#intro")
    }

    @MainActor
    func testUnregisterSurfacePreservesSceneIdentityAndContentForPlatformRestore() {
        let suiteName = "SurfAceSurfaceTopologyPersistenceTests.\(UUID().uuidString)"
        guard let userDefaults = UserDefaults(suiteName: suiteName) else {
            XCTFail("Expected isolated UserDefaults suite")
            return
        }
        userDefaults.removePersistentDomain(forName: suiteName)
        defer {
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let firstRuntime = SurfAceRuntime(userDefaults: userDefaults)
        let firstSurface = firstRuntime.registerSurface(sceneKey: "scene-restored")
        let pane = SurfAcePaneModel(paneId: 1, paneLineageId: "pl_restore", paneLabel: 1, name: "Restored")
        pane.currentEntry = SurfAcePaneEntry(
            contentId: "ct_restore",
            revision: 4,
            historyOwnerToken: "hot_restore",
            contentType: .html,
            payload: .html(html: "<main><p>Restored body</p></main>", baseURL: nil),
            title: "Restored HTML",
            scrollable: true,
            interactive: true,
            url: nil,
            drawingData: Data(),
            strokesById: [:]
        )
        pane.currentTarget = SurfAcePaneTargetState(
            targetId: "ct_restore",
            targetKind: "html",
            paneLineageId: "pl_restore",
            targetEpoch: 4,
            restorePolicy: "auto",
            currentState: "applied"
        )
        firstSurface.windowLabel = "a"
        firstSurface.panesById = [1: pane]
        firstSurface.paneLayout = .leaf(1)
        firstSurface.providerTopologyInitialized = true
        firstRuntime.persistSurfaceTopology(surfaceId: firstSurface.surfaceId)
        firstRuntime.unregisterSurface(sceneKey: "scene-restored")
        XCTAssertTrue(firstRuntime.surfaces.isEmpty)

        let relaunchedRuntime = SurfAceRuntime(userDefaults: userDefaults)
        let reopenedSurface = relaunchedRuntime.registerSurface(sceneKey: "scene-restored")
        let reopenedPane = reopenedSurface.panes.first

        XCTAssertEqual(reopenedSurface.surfaceId, firstSurface.surfaceId)
        XCTAssertEqual(reopenedSurface.windowLabel, "a")
        XCTAssertTrue(reopenedSurface.providerTopologyInitialized)
        XCTAssertEqual(reopenedPane?.paneLineageId, "pl_restore")
        XCTAssertEqual(reopenedPane?.currentEntry.contentType, .html)
        XCTAssertEqual(reopenedPane?.currentEntry.title, "Restored HTML")
        XCTAssertEqual(reopenedPane?.currentEntry.revision, 4)
        XCTAssertEqual(reopenedPane?.currentTarget?.targetId, "ct_restore")
        XCTAssertEqual(reopenedPane?.currentTarget?.targetKind, "html")
    }

    @MainActor
    func testRestoredSceneSurfacesKeepDistinctTopology() {
        let suiteName = "SurfAceSurfaceTopologyPersistenceTests.\(UUID().uuidString)"
        guard let userDefaults = UserDefaults(suiteName: suiteName) else {
            XCTFail("Expected isolated UserDefaults suite")
            return
        }
        userDefaults.removePersistentDomain(forName: suiteName)
        defer {
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let firstRuntime = SurfAceRuntime(userDefaults: userDefaults)
        let firstSurface = firstRuntime.registerSurface(sceneKey: "scene-ff")
        firstSurface.windowLabel = "ff"
        firstSurface.name = "Surf Ace FF"
        firstSurface.panesById = [164: SurfAcePaneModel(paneId: 164, paneLabel: 164, name: "FF")]
        firstSurface.paneLayout = .leaf(164)
        firstSurface.activeKeyboardPaneId = 164
        firstSurface.providerTopologyInitialized = true
        firstRuntime.persistSurfaceTopology(surfaceId: firstSurface.surfaceId)

        let secondSurface = firstRuntime.registerSurface(sceneKey: "scene-fh")
        secondSurface.windowLabel = "fh"
        secondSurface.name = "Surf Ace FH"
        secondSurface.panesById = [165: SurfAcePaneModel(paneId: 165, paneLabel: 165, name: "FH")]
        secondSurface.paneLayout = .leaf(165)
        secondSurface.activeKeyboardPaneId = 165
        secondSurface.providerTopologyInitialized = true
        firstRuntime.persistSurfaceTopology(surfaceId: secondSurface.surfaceId)

        let thirdSurface = firstRuntime.registerSurface(sceneKey: "scene-fi")
        thirdSurface.windowLabel = "fi"
        thirdSurface.name = "Surf Ace FI"
        thirdSurface.panesById = [166: SurfAcePaneModel(paneId: 166, paneLabel: 166, name: "FI")]
        thirdSurface.paneLayout = .leaf(166)
        thirdSurface.activeKeyboardPaneId = 166
        thirdSurface.providerTopologyInitialized = true
        firstRuntime.persistSurfaceTopology(surfaceId: thirdSurface.surfaceId)

        let relaunchedRuntime = SurfAceRuntime(userDefaults: userDefaults)
        let restoredFF = relaunchedRuntime.registerSurface(sceneKey: "scene-ff")
        let restoredFH = relaunchedRuntime.registerSurface(sceneKey: "scene-fh")
        let restoredFI = relaunchedRuntime.registerSurface(sceneKey: "scene-fi")

        XCTAssertEqual(Set(relaunchedRuntime.surfaces.map(\.surfaceId)).count, 3)
        XCTAssertEqual(restoredFF.surfaceId, firstSurface.surfaceId)
        XCTAssertEqual(restoredFH.surfaceId, secondSurface.surfaceId)
        XCTAssertEqual(restoredFI.surfaceId, thirdSurface.surfaceId)
        XCTAssertEqual(restoredFF.windowLabel, "ff")
        XCTAssertEqual(restoredFH.windowLabel, "fh")
        XCTAssertEqual(restoredFI.windowLabel, "fi")
        XCTAssertEqual(restoredFF.panes.map(\.paneLabel), [164])
        XCTAssertEqual(restoredFH.panes.map(\.paneLabel), [165])
        XCTAssertEqual(restoredFI.panes.map(\.paneLabel), [166])
    }
}

final class SurfAcePaneGeometrySnapshotTests: XCTestCase {
    @MainActor
    func testPaneViewportPayloadUsesSwiftUIResolvedSnapshotIncludingSplitSpacing() {
        let runtime = SurfAceRuntime()
        let surface = runtime.registerSurface(sceneKey: "geometry-split")
        runtime.updateViewport(surfaceId: surface.surfaceId, size: CGSize(width: 601, height: 300), scale: 2)
        surface.panesById = [
            1: SurfAcePaneModel(paneId: 1, paneLabel: 1),
            2: SurfAcePaneModel(paneId: 2, paneLabel: 2),
        ]
        surface.paneLayout = .split(direction: .vertical, children: [.leaf(1), .leaf(2)])
        surface.topologyEpoch = 7

        runtime.updatePaneGeometrySnapshot(
            surfaceId: surface.surfaceId,
            paneId: 1,
            paneFrame: CGRect(x: 0, y: 0, width: 300, height: 300),
            contentViewport: CGRect(x: 0, y: 0, width: 300, height: 300),
            splitSpacing: surfAcePaneSplitSpacing
        )
        runtime.updatePaneGeometrySnapshot(
            surfaceId: surface.surfaceId,
            paneId: 2,
            paneFrame: CGRect(x: 301, y: 0, width: 300, height: 300),
            contentViewport: CGRect(x: 301, y: 0, width: 300, height: 300),
            splitSpacing: surfAcePaneSplitSpacing
        )

        let firstPayload = runtime.paneViewportPayload(surfaceId: surface.surfaceId, paneId: 1)
        let secondPayload = runtime.paneViewportPayload(surfaceId: surface.surfaceId, paneId: 2)
        let firstGeometry = runtime.paneGeometryPayload(surfaceId: surface.surfaceId, paneId: 1)
        let secondGeometry = runtime.paneGeometryPayload(surfaceId: surface.surfaceId, paneId: 2)
        let firstContentViewport = firstGeometry["contentViewport"] as? [String: Double]
        let secondContentViewport = secondGeometry["contentViewport"] as? [String: Double]

        XCTAssertEqual(firstPayload["width"] as? Int, 300)
        XCTAssertEqual(secondPayload["width"] as? Int, 300)
        XCTAssertEqual(firstPayload["scale"] as? Double, 2)
        XCTAssertNil(firstPayload["x"])
        XCTAssertNil(firstPayload["coordinateSpace"])
        XCTAssertEqual(firstContentViewport?["x"], 0)
        XCTAssertEqual(firstContentViewport?["width"], 300)
        XCTAssertEqual(secondContentViewport?["x"], 301)
        XCTAssertEqual(secondContentViewport?["width"], 300)
        XCTAssertEqual(firstGeometry["coordinateSpace"] as? String, SurfAcePaneGeometrySnapshot.coordinateSpace)
        XCTAssertEqual(firstGeometry["topologyEpoch"] as? Int, 7)
        XCTAssertEqual(firstGeometry["surfaceEpoch"] as? String, String(surface.surfaceEpoch))
        XCTAssertEqual(firstGeometry["geometryRevision"] as? Int, surface.panesById[1]?.geometrySnapshot?.geometryRevision)
        XCTAssertEqual(firstGeometry["paneInstanceId"] as? String, surface.panesById[1]?.paneInstanceId)
    }

    @MainActor
    func testPaneGeometryRevisionChangesOnlyWhenAppliedSnapshotChanges() {
        let runtime = SurfAceRuntime()
        let surface = runtime.registerSurface(sceneKey: "geometry-revision")
        runtime.updateViewport(surfaceId: surface.surfaceId, size: CGSize(width: 400, height: 300), scale: 1)

        let frame = CGRect(x: 0, y: 0, width: 400, height: 300)
        runtime.updatePaneGeometrySnapshot(
            surfaceId: surface.surfaceId,
            paneId: 1,
            paneFrame: frame,
            contentViewport: frame,
            splitSpacing: surfAcePaneSplitSpacing
        )
        let initialRevision = surface.panesById[1]?.geometrySnapshot?.geometryRevision

        runtime.updatePaneGeometrySnapshot(
            surfaceId: surface.surfaceId,
            paneId: 1,
            paneFrame: frame,
            contentViewport: frame,
            splitSpacing: surfAcePaneSplitSpacing
        )
        XCTAssertEqual(surface.panesById[1]?.geometrySnapshot?.geometryRevision, initialRevision)

        let resizedFrame = CGRect(x: 0, y: 0, width: 320, height: 300)
        runtime.updatePaneGeometrySnapshot(
            surfaceId: surface.surfaceId,
            paneId: 1,
            paneFrame: resizedFrame,
            contentViewport: resizedFrame,
            splitSpacing: surfAcePaneSplitSpacing
        )
        XCTAssertNotEqual(surface.panesById[1]?.geometrySnapshot?.geometryRevision, initialRevision)
        XCTAssertEqual(runtime.paneViewportPayload(surfaceId: surface.surfaceId, paneId: 1)["width"] as? Int, 320)
    }

    @MainActor
    func testPaneViewportPayloadDoesNotReportStaleSnapshotAfterTopologyEpochChanges() {
        let runtime = SurfAceRuntime()
        let surface = runtime.registerSurface(sceneKey: "geometry-stale")
        runtime.updateViewport(surfaceId: surface.surfaceId, size: CGSize(width: 400, height: 300), scale: 2)

        let frame = CGRect(x: 0, y: 0, width: 400, height: 300)
        runtime.updatePaneGeometrySnapshot(
            surfaceId: surface.surfaceId,
            paneId: 1,
            paneFrame: frame,
            contentViewport: frame,
            splitSpacing: surfAcePaneSplitSpacing
        )
        XCTAssertEqual(runtime.paneViewportPayload(surfaceId: surface.surfaceId, paneId: 1)["width"] as? Int, 400)

        surface.topologyEpoch += 1

        let staleViewport = runtime.paneViewportPayload(surfaceId: surface.surfaceId, paneId: 1)
        let staleGeometry = runtime.paneGeometryPayload(surfaceId: surface.surfaceId, paneId: 1)
        let staleContentViewport = staleGeometry["contentViewport"] as? [String: Double]

        XCTAssertEqual(staleViewport["width"] as? Int, 400)
        XCTAssertEqual(staleGeometry["geometryRevision"] as? Int, 0)
        XCTAssertEqual(staleGeometry["geometryUnavailable"] as? Bool, true)
        XCTAssertEqual(staleGeometry["unavailableReason"] as? String, "missing_resolved_snapshot")
        XCTAssertEqual(staleGeometry["topologyEpoch"] as? Int, surface.topologyEpoch)
        XCTAssertEqual(staleContentViewport?["width"], 400)
    }
}

@MainActor
final class SurfAceHostZoomViewportTests: XCTestCase {
    // Frozen operational inputs live only in the owned simulator app's cache,
    // not in the source repository, signed bundle, or a live-origin fetch.
    private func frozenInput(_ name: String, sha256: String) throws -> Data {
        let cache = try XCTUnwrap(FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first)
        let url = cache.appendingPathComponent("HostZoomFixture", isDirectory: true).appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw XCTSkip("Hash-bound offline taskboard inputs were not staged in the owned test app")
        }
        let data = try Data(contentsOf: url)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(digest, sha256, "Frozen fixture integrity")
        guard digest == sha256 else { throw NSError(domain: "ZoomFixtureIntegrity", code: 1) }
        return data
    }

    func testFrozenTaskboardKeepsFullNativeViewportAtSupportedFontScales() async throws {
        let index = try frozenInput("host-zoom-index.html", sha256: "731ce9b945ee5594e162576017a2d01f31b33878fb803676e45f80fc381af809")
        let board = try frozenInput("host-zoom-board.json", sha256: "371fa9d3c0d49c00f092ed6a8b799d8b5a8e6a5dc928d2eb615ee43293ddeb2f")
        let wrapperData = try frozenInput("host-zoom-wrapper.json", sha256: "498c1ea9dde6f9b84e65b7c60a805e300cacef210325b770a99959ea80413537")
        let input = try XCTUnwrap(JSONSerialization.jsonObject(with: wrapperData) as? [String: Any])
        let content = try XCTUnwrap(input["content"] as? [String: Any])
        let originalWrapper = try XCTUnwrap(content["html"] as? String)
        let marker = UUID().uuidString
        let server = SurfAceHTTPServer()
        let port = try await server.startIsolatedLoopbackForTesting(
            httpHandler: { request in
                switch request.path {
                case "/identity": return HTTPServerResponse(statusCode: 200, body: Data(marker.utf8))
                case "/index.html": return HTTPServerResponse(statusCode: 200, headers: ["Content-Type": "text/html"], body: index)
                case "/board.json": return HTTPServerResponse(statusCode: 200, headers: ["Content-Type": "application/json"], body: board)
                default: return HTTPServerResponse(statusCode: 404)
                }
            }, webSocketHandler: { socket in await socket.close() }
        )
        // Only this OS-assigned, no-reuse loopback listener belongs to the fixture.
        defer { Task { await server.stop() } }
        XCTAssertNotEqual(port, SurfAceHTTPServer.fixedPort)
        let baseURL = try XCTUnwrap(URL(string: "http://127.0.0.1:\(port)/"))
        let (identity, _) = try await URLSession.shared.data(from: baseURL.appendingPathComponent("identity"))
        XCTAssertEqual(String(decoding: identity, as: UTF8.self), marker)
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1024, height: 820)
        let controller = UIViewController()
        let host = SurfAceSurfaceHostView(frame: window.bounds)
        controller.view = host; window.rootViewController = controller; window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKey() }
        let web = try XCTUnwrap(host.subviews.compactMap { $0 as? WKWebView }.first)
        let rules = """
        [{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}},
         {"trigger":{"url-filter":"^http://127[.]0[.]0[.]1:\(port)/"},"action":{"type":"ignore-previous-rules"}}]
        """
        let ruleList = try await WKContentRuleListStore.default().compileContentRuleList(
            forIdentifier: "offline-zoom-\(marker)", encodedContentRuleList: rules)
        web.configuration.userContentController.add(try XCTUnwrap(ruleList))
        defer { web.configuration.userContentController.removeAllContentRuleLists() }
        // Preserve the frozen wrapper's layout; substitute only its URL origin.
        let pattern = try NSRegularExpression(pattern: "src=\"[^\"]*\"")
        let wrapper = pattern.stringByReplacingMatches(in: originalWrapper,
            range: NSRange(originalWrapper.startIndex..., in: originalWrapper),
            withTemplate: "src=\"\(baseURL.appendingPathComponent("index.html").absoluteString)\"")
        // Compare scale changes AFTER the asynchronous frozen board has laid out.
        // Preloading at effective scale 1 is a test control, not a production fix.
        host.setContentScale(1 / 0.85)
        host.render(entry: .from(frame: SurfAceFrame(contentId: "frozen-taskboard",
            revision: 1, contentType: .html, payload: .html(html: wrapper, baseURL: baseURL.absoluteString),
            reloadSource: nil, title: "Frozen taskboard", scrollable: true, interactive: true)), restoreViewport: nil)
        _ = await host.fetchSnapshotMetadata()
        _ = try await web.callAsyncJavaScript("""
        const d=document.querySelector('iframe').contentDocument;
        if (!d.querySelector('#task-board-scroll')) await new Promise((resolve,reject)=>{
          const observer=new MutationObserver(()=>{if(d.querySelector('#task-board-scroll')){observer.disconnect();clearTimeout(timer);resolve();}});
          const timer=setTimeout(()=>{observer.disconnect();reject(Error('frozen board readiness timed out'));},10000);
          observer.observe(d.documentElement,{childList:true,subtree:true});
        });
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
        return true;
        """, arguments: [:], in: nil, contentWorld: .page)
        for multiplier in [1.0, 0.5, 1.5, 2.0] {
            host.setContentScale(CGFloat(multiplier))
            let metrics = try await web.callAsyncJavaScript("""
            if (Number(document.body.style.getPropertyValue('--surf-ace-content-scale')) !== scale) await new Promise((resolve,reject)=>{
              const observer=new MutationObserver(()=>{if(Number(document.body.style.getPropertyValue('--surf-ace-content-scale'))===scale){observer.disconnect();clearTimeout(timer);resolve();}});
              const timer=setTimeout(()=>{observer.disconnect();reject(Error('content scale completion timed out'));},10000);
              observer.observe(document.body,{attributes:true,attributeFilter:['style']});
            });
            await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
            const f=document.querySelector('iframe'), d=f.contentDocument;
            if (!d.querySelector('#task-board-scroll')) await new Promise((resolve,reject)=>{
              const observer=new MutationObserver(()=>{if(d.querySelector('#task-board-scroll')){observer.disconnect();clearTimeout(timer);resolve();}});
              const timer=setTimeout(()=>{observer.disconnect();reject(Error('frozen board readiness timed out'));},10000);
              observer.observe(d.documentElement,{childList:true,subtree:true});
            });
            const w=f.contentWindow, e=d.querySelector('#task-board-scroll'), r=e.getBoundingClientRect();
            return {innerWidth:w.innerWidth,innerHeight:w.innerHeight,clientWidth:d.documentElement.clientWidth,
              clientHeight:d.documentElement.clientHeight,scrollerWidth:r.width,scrollerHeight:r.height,
              outerWidth:innerWidth,outerHeight:innerHeight,rootZoom:getComputedStyle(document.documentElement).zoom,
              innerZoom:w.getComputedStyle(d.documentElement).zoom,dpr:w.devicePixelRatio};
            """, arguments: ["scale": (0.85 * multiplier * 1000).rounded() / 1000], in: nil, contentWorld: .page)
            let dimensions = try XCTUnwrap(metrics as? [String: Any])
            let attachment = XCTAttachment(data: try JSONSerialization.data(withJSONObject: [
                "multiplier": multiplier, "dom": dimensions, "webFrame": NSCoder.string(for: web.frame),
                "hostBounds": NSCoder.string(for: host.bounds), "pageZoom": web.pageZoom,
                "safeAreaInsets": NSCoder.string(for: host.safeAreaInsets),
                "adjustedContentInsets": NSCoder.string(for: web.scrollView.adjustedContentInset),
                "webOpaque": web.isOpaque, "webBackground": String(describing: web.backgroundColor)
            ], options: [.sortedKeys, .prettyPrinted]), uniformTypeIdentifier: "public.json")
            attachment.name = "frozen-taskboard-geometry-\(multiplier)"; attachment.lifetime = .keepAlways; add(attachment)
            let snapshot = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UIImage, Error>) in
                web.takeSnapshot(with: nil) { image, error in
                    if let image { continuation.resume(returning: image) }
                    else { continuation.resume(throwing: error ?? NSError(domain: "ZoomSnapshot", code: 1)) }
                }
            }
            let screenshot = XCTAttachment(image: snapshot)
            screenshot.name = "frozen-taskboard-native-\(multiplier)"; screenshot.lifetime = .keepAlways; add(screenshot)
            let image = try XCTUnwrap(snapshot.cgImage)
            var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
            let painted = pixels.withUnsafeMutableBytes { bytes -> Bool in
                guard let context = CGContext(data: bytes.baseAddress, width: image.width, height: image.height,
                    bitsPerComponent: 8, bytesPerRow: image.width * 4, space: CGColorSpaceCreateDeviceRGB(),
                    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
                context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(image.width), height: CGFloat(image.height)))
                return true
            }
            XCTAssertTrue(painted)
            for x in [image.width / 2, image.width - 4] {
                for y in [4, image.height - 4] {
                    let i = (y * image.width + x) * 4
                    XCTAssertGreaterThan(pixels[i + 3], 240, "Frozen board must paint its native viewport edge")
                    XCTAssertFalse(pixels[i] > 245 && pixels[i + 1] > 245 && pixels[i + 2] > 245,
                                   "Frozen board must not leave an unpainted white strip")
                }
            }
            let width = try XCTUnwrap(dimensions["innerWidth"] as? Double)
            let height = try XCTUnwrap(dimensions["innerHeight"] as? Double)
            XCTAssertEqual(try XCTUnwrap(dimensions["scrollerWidth"] as? Double), width, accuracy: 1)
            XCTAssertEqual(try XCTUnwrap(dimensions["scrollerHeight"] as? Double), height, accuracy: 1)
            XCTAssertEqual(web.frame, host.bounds)
            XCTAssertEqual(web.scrollView.adjustedContentInset, .zero, "Pane already owns its native viewport")
        }
        await server.stop()
    }

    func testNativeHostKeepsFullIframeViewportAtSupportedFontScales() async throws {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first)
        let previous = scene.windows.first(where: \.isKeyWindow)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 1024, height: 820)
        let controller = UIViewController()
        let host = SurfAceSurfaceHostView(frame: window.bounds)
        controller.view = host
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true; window.rootViewController = nil; previous?.makeKey() }
        let web = try XCTUnwrap(host.subviews.compactMap { $0 as? WKWebView }.first)
        for pattern in ["fixed", "percent"] {
            var defaultFontPixelWidth: Int?
            for multiplier in [1.0, 0.5, 1.5, 2.0] {
                let fill = pattern == "fixed" ? "position:fixed;inset:0" : "width:100%;height:100%"
                let inner = "<html style='height:100%'><body style='margin:0;height:100%'><main id='fill' style='\(fill);background:rgb(0,200,0)'><span id='font' style='font-size:20px'>Scale</span><span id='scale-marker' style='position:fixed;top:40px;left:40px;width:20px;height:20px;background:rgb(200,0,0)'></span></main></body></html>"
                let encoded = inner.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "\"", with: "&quot;")
                let html = "<html style='height:100%;background:#101720'><head><meta name='viewport' content='width=device-width,initial-scale=1'></head><body style='margin:0;height:100%;overflow:hidden'><iframe style='display:block;border:0;width:100%;height:100%' srcdoc=\"\(encoded)\"></iframe></body></html>"
                host.setContentScale(CGFloat(multiplier))
                host.render(entry: .from(frame: SurfAceFrame(
                    contentId: "zoom-\(pattern)-\(multiplier)", revision: 1, contentType: .html,
                    payload: .html(html: html, baseURL: nil), reloadSource: nil,
                    title: "Zoom fixture", scrollable: true, interactive: true)), restoreViewport: nil)
                host.layoutIfNeeded()
                // Uses the production navigation/scale/paint completion signal.
                _ = await host.fetchSnapshotMetadata()
                let metrics = try await web.evaluateJavaScript("""
                (() => { const f=document.querySelector('iframe'), w=f.contentWindow, d=w.document;
                  const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}};
                  return {outer:{width:innerWidth,height:innerHeight,zoom:getComputedStyle(document.documentElement).zoom},
                    iframe:rect(f),inner:{width:w.innerWidth,height:w.innerHeight,dpr:w.devicePixelRatio,
                    clientWidth:d.documentElement.clientWidth,clientHeight:d.documentElement.clientHeight,
                    fill:rect(d.querySelector('#fill')),fontBounds:rect(d.querySelector('#font')),scaleMarker:rect(d.querySelector('#scale-marker')),fontSize:w.getComputedStyle(d.querySelector('#font')).fontSize}};
                })()
                """)
                let snapshot = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<UIImage, Error>) in
                    web.takeSnapshot(with: nil) { image, error in
                        if let image { continuation.resume(returning: image) }
                        else { continuation.resume(throwing: error ?? NSError(domain: "ZoomSnapshot", code: 1)) }
                    }
                }
                let label = "\(pattern)-\(multiplier)"
                let attachment = XCTAttachment(image: snapshot)
                attachment.name = "native-iframe-\(label)"; attachment.lifetime = .keepAlways; add(attachment)
                let inset = web.scrollView.adjustedContentInset
                let measurements: [String: Any] = [
                    "pattern": pattern, "multiplier": multiplier, "pageZoom": web.pageZoom,
                    "hostBounds": NSCoder.string(for: host.bounds), "webFrame": NSCoder.string(for: web.frame),
                    "webBounds": NSCoder.string(for: web.bounds), "safeAreaInsets": NSCoder.string(for: host.safeAreaInsets),
                    "adjustedContentInsets": NSCoder.string(for: inset),
                    "webOpaque": web.isOpaque, "webBackground": String(describing: web.backgroundColor),
                    "snapshotPoints": [snapshot.size.width, snapshot.size.height], "dom": try XCTUnwrap(metrics)
                ]
                let data = try JSONSerialization.data(withJSONObject: measurements, options: [.sortedKeys, .prettyPrinted])
                let geometry = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
                geometry.name = "native-geometry-\(label)"; geometry.lifetime = .keepAlways; add(geometry)
                XCTAssertEqual(web.frame, host.bounds, "\(label) native edge pinning")
                let image = try XCTUnwrap(snapshot.cgImage)
                var pixels = [UInt8](repeating: 0, count: image.width * image.height * 4)
                let colorSpace = CGColorSpaceCreateDeviceRGB()
                let painted = pixels.withUnsafeMutableBytes { bytes -> Bool in
                    guard let context = CGContext(data: bytes.baseAddress, width: image.width, height: image.height,
                        bitsPerComponent: 8, bytesPerRow: image.width * 4, space: colorSpace,
                        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
                    context.draw(image, in: CGRect(x: 0, y: 0, width: CGFloat(image.width), height: CGFloat(image.height))); return true
                }
                XCTAssertTrue(painted)
                var markerMinX = image.width, markerMaxX = -1
                var fontMinX = image.width, fontMaxX = -1
                for y in 0..<image.height {
                    for x in 0..<image.width {
                        let i = (y * image.width + x) * 4
                        if pixels[i + 3] > 200 && pixels[i] > 150 && pixels[i + 1] < 40 && pixels[i + 2] < 40 {
                            markerMinX = min(markerMinX, x); markerMaxX = max(markerMaxX, x)
                        }
                        // The fixture's only opaque black pixels are its font glyphs.
                        if pixels[i + 3] > 200 && pixels[i] < 40 && pixels[i + 1] < 40 && pixels[i + 2] < 40 {
                            fontMinX = min(fontMinX, x); fontMaxX = max(fontMaxX, x)
                        }
                    }
                }
                XCTAssertGreaterThanOrEqual(markerMaxX, markerMinX, "Physical scale marker must be painted")
                let nativePixelsPerPoint = Double(image.width) / Double(host.bounds.width)
                let expectedMarkerWidth = 20 * 0.85 * multiplier * nativePixelsPerPoint
                XCTAssertEqual(Double(markerMaxX - markerMinX + 1), expectedMarkerWidth, accuracy: 1.5,
                               "Preserve intended 0.85 base times pane multiplier in physical paint")
                XCTAssertGreaterThanOrEqual(fontMaxX, fontMinX, "Font glyphs must be painted")
                let fontWidth = fontMaxX - fontMinX + 1
                if multiplier == 1 { defaultFontPixelWidth = fontWidth }
                else if let reference = defaultFontPixelWidth {
                    XCTAssertEqual(Double(fontWidth), Double(reference) * multiplier, accuracy: 3,
                                   "Physical glyph sizing must follow the pane's font scale")
                }
                let paintMetrics = XCTAttachment(data: try JSONSerialization.data(withJSONObject: [
                    "markerWidthPixels": markerMaxX - markerMinX + 1, "expectedMarkerWidthPixels": expectedMarkerWidth,
                    "fontGlyphWidthPixels": fontWidth, "nativePixelsPerPoint": nativePixelsPerPoint
                ], options: [.sortedKeys]), uniformTypeIdentifier: "public.json")
                paintMetrics.name = "physical-font-scale-\(label)"; paintMetrics.lifetime = .keepAlways; add(paintMetrics)
                // Both vertical orientations are sampled; no white/dark margin can pass.
                for x in [image.width / 2, image.width - 4] {
                    for y in [4, image.height - 4] {
                        let i = (y * image.width + x) * 4
                        XCTAssertTrue(pixels[i + 1] > 150 && pixels[i] < 40 && pixels[i + 2] < 40,
                                      "\(label) usable iframe must paint native viewport edge (\(x),\(y)); RGBA=\(Array(pixels[i...i+3]))")
                    }
                }
            }
        }
    }
}
