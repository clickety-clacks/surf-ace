import XCTest
import SwiftUI
import WebKit
@testable import SurfAce

final class SurfAceSurfaceTopologyPersistenceTests: XCTestCase {
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
        var tiledFrames = views.map { $0.convert($0.bounds, to: window) }
        var surfaceFrame = tiledFrames.reduce(CGRect.null) { $0.union($1) }
        for index in 0..<4 {
            selection.paneId = 3
            await Task.yield()
            host.view.layoutIfNeeded()
            XCTAssertEqual(selection.paneId, 3)
            let expandedFrame = surfAcePanePopoutBounds(in: surfaceFrame)
            await waitForPopoutFrame(selected, in: window, expected: expandedFrame)
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
            selection.paneId = nil
            await waitForPopoutFrame(selected, in: window,
                                    expected: tiledFrames[try XCTUnwrap(views.firstIndex(of: selected))])
            if index == 1 {
                window.frame = CGRect(x: 0, y: 0, width: 900, height: 600)
                host.view.frame = window.bounds
            }
            await Task.yield()
            host.view.layoutIfNeeded()
            if index == 1 {
                let resized = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    views[0].convert(views[0].bounds, to: window).width != tiledFrames[0].width
                }, object: nil)
                await fulfillment(of: [resized], timeout: 5)
                tiledFrames = views.map { $0.convert($0.bounds, to: window) }
                surfaceFrame = tiledFrames.reduce(CGRect.null) { $0.union($1) }
            }
        }
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
        surface.topologyEpoch += 1
        await Task.yield()
        host.view.layoutIfNeeded()
        XCTAssertNil(selection.paneId, "external topology replacement ends the presentation")
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
    private func popoutWebViews(in view: UIView) -> [WKWebView] {
        (view as? WKWebView).map { [$0] } ?? view.subviews.flatMap { popoutWebViews(in: $0) }
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
