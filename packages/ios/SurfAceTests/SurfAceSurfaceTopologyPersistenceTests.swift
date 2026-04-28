import XCTest
@testable import SurfAce

final class SurfAceSurfaceTopologyPersistenceTests: XCTestCase {
    @MainActor
    func testPaneLabelTextUsesVisiblePaneLabelNotOptionalName() {
        let pane = SurfAcePaneModel(paneId: 9, paneLabel: 42, name: "Right")

        XCTAssertEqual(pane.labelText, "42")
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

        XCTAssertEqual(staleViewport["width"] as? Int, 1)
        XCTAssertEqual(staleGeometry["geometryRevision"] as? Int, 0)
        XCTAssertEqual(staleGeometry["topologyEpoch"] as? Int, surface.topologyEpoch)
        XCTAssertEqual(staleContentViewport?["width"], 1)
    }
}
