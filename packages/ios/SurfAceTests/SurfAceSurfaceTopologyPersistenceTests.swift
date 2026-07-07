import XCTest
@testable import SurfAce

final class SurfAceSurfaceTopologyPersistenceTests: XCTestCase {
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

    func testProviderBootstrapIdentityRejectsCallerControlledWindowLabels() {
        XCTAssertEqual(surfAceValidatedProviderWindowLabel(from: "a"), "a")
        XCTAssertEqual(surfAceValidatedProviderWindowLabel(from: "aa"), "aa")

        XCTAssertNil(surfAceValidatedProviderWindowLabel(from: "DOCS"))
        XCTAssertNil(surfAceValidatedProviderWindowLabel(from: "RACTER GRAPHICAL NATIVE"))
        XCTAssertNil(surfAceValidatedProviderWindowLabel(from: " a"))
        XCTAssertNil(surfAceValidatedProviderWindowLabel(from: "a1"))
        XCTAssertNil(surfAceValidatedProviderWindowLabel(from: ""))
        XCTAssertNil(surfAceValidatedProviderWindowLabel(from: 1))
    }

    func testProviderBootstrapIdentityRequiresExplicitPaneIdsAndLabels() {
        let valid = surfAceValidatedProviderBootstrapIdentity(from: [
            "windowLabel": "b",
            "initialPaneId": 42,
            "initialPaneLabel": 7,
        ])
        XCTAssertEqual(valid?.windowLabel, "b")
        XCTAssertEqual(valid?.initialPaneId, 42)
        XCTAssertEqual(valid?.initialPaneLabel, 7)

        XCTAssertNil(surfAceValidatedProviderBootstrapIdentity(from: [
            "windowLabel": "b",
            "initialPaneId": 42,
        ]))
        XCTAssertNil(surfAceValidatedProviderBootstrapIdentity(from: [
            "windowLabel": "b",
            "initialPaneId": 42,
            "initialPaneLabel": 0,
        ]))
        XCTAssertNil(surfAceValidatedProviderBootstrapIdentity(from: [
            "windowLabel": "DOCS",
            "initialPaneId": 42,
            "initialPaneLabel": 7,
        ]))
    }

    func testAuthorityStateRequiresProviderActionabilityAndAdoptsSameProviderPaneIdentity() {
        let panes = [
            SurfAceAuthorityPaneIdentity(paneId: 41, paneLabel: 1, paneLineageId: "pl_41"),
        ]
        let basePayload: [String: Any] = [
            "actionable": true,
            "reason": NSNull(),
            "ownershipEpoch": 7,
            "providerId": "pv_1",
            "sessionId": "sa_1",
            "surfaceId": "sf_1",
            "windowLabel": "a",
            "panes": [
                [
                    "paneId": 41,
                    "paneLabel": 1,
                    "paneLineageId": "pl_41",
                ],
            ],
        ]

        XCTAssertNil(surfAceAuthorityStateRejectionReason(
            payload: basePayload,
            surfaceId: "sf_1",
            providerId: "pv_1",
            sessionId: "sa_1",
            ownershipEpoch: 7,
            lockProviderId: "pv_1",
            lockSessionId: "sa_1",
            windowLabel: "a",
            panes: panes
        ))

        var providerRelabelPayload = basePayload
        providerRelabelPayload["windowLabel"] = "b"
        XCTAssertNil(surfAceAuthorityStateRejectionReason(
            payload: providerRelabelPayload,
            surfaceId: "sf_1",
            providerId: "pv_1",
            sessionId: "sa_1",
            ownershipEpoch: 7,
            lockProviderId: "pv_1",
            lockSessionId: "sa_1",
            windowLabel: "a",
            panes: panes
        ))

        var invalidWindowLabelPayload = basePayload
        invalidWindowLabelPayload["windowLabel"] = "B"
        XCTAssertEqual(surfAceAuthorityStateRejectionReason(
            payload: invalidWindowLabelPayload,
            surfaceId: "sf_1",
            providerId: "pv_1",
            sessionId: "sa_1",
            ownershipEpoch: 7,
            lockProviderId: "pv_1",
            lockSessionId: "sa_1",
            windowLabel: "a",
            panes: panes
        ), "window_label_mismatch")

        var foreignProviderPayload = basePayload
        foreignProviderPayload["providerId"] = "pv_2"
        XCTAssertEqual(surfAceAuthorityStateRejectionReason(
            payload: foreignProviderPayload,
            surfaceId: "sf_1",
            providerId: "pv_1",
            sessionId: "sa_1",
            ownershipEpoch: 7,
            lockProviderId: "pv_1",
            lockSessionId: "sa_1",
            windowLabel: "a",
            panes: panes
        ), "session_identity_mismatch")

        let reorderedPanes = [
            SurfAceAuthorityPaneIdentity(paneId: 42, paneLabel: 2, paneLineageId: "pl_42"),
            SurfAceAuthorityPaneIdentity(paneId: 41, paneLabel: 1, paneLineageId: "pl_41"),
        ]
        var topologyOrderPayload = basePayload
        topologyOrderPayload["panes"] = [
            [
                "paneId": 41,
                "paneLabel": 1,
                "paneLineageId": "pl_41",
            ],
            [
                "paneId": 42,
                "paneLabel": 2,
                "paneLineageId": "pl_42",
            ],
        ]
        XCTAssertNil(surfAceAuthorityStateRejectionReason(
            payload: topologyOrderPayload,
            surfaceId: "sf_1",
            providerId: "pv_1",
            sessionId: "sa_1",
            ownershipEpoch: 7,
            lockProviderId: "pv_1",
            lockSessionId: "sa_1",
            windowLabel: "a",
            panes: reorderedPanes
        ))

        var duplicatePanePayload = topologyOrderPayload
        duplicatePanePayload["panes"] = [
            [
                "paneId": 41,
                "paneLabel": 1,
                "paneLineageId": "pl_41",
            ],
            [
                "paneId": 41,
                "paneLabel": 1,
                "paneLineageId": "pl_41",
            ],
        ]
        XCTAssertEqual(surfAceAuthorityStateRejectionReason(
            payload: duplicatePanePayload,
            surfaceId: "sf_1",
            providerId: "pv_1",
            sessionId: "sa_1",
            ownershipEpoch: 7,
            lockProviderId: "pv_1",
            lockSessionId: "sa_1",
            windowLabel: "a",
            panes: reorderedPanes
        ), "pane_identity_mismatch")

        var wrongPaneLabel = basePayload
        wrongPaneLabel["panes"] = [
            [
                "paneId": 41,
                "paneLabel": 2,
                "paneLineageId": "pl_41",
            ],
        ]
        XCTAssertNil(surfAceAuthorityStateRejectionReason(
            payload: wrongPaneLabel,
            surfaceId: "sf_1",
            providerId: "pv_1",
            sessionId: "sa_1",
            ownershipEpoch: 7,
            lockProviderId: "pv_1",
            lockSessionId: "sa_1",
            windowLabel: "a",
            panes: panes
        ))

        var wrongPaneLineage = basePayload
        wrongPaneLineage["panes"] = [
            [
                "paneId": 41,
                "paneLabel": 1,
                "paneLineageId": "pl_provider_truth",
            ],
        ]
        XCTAssertNil(surfAceAuthorityStateRejectionReason(
            payload: wrongPaneLineage,
            surfaceId: "sf_1",
            providerId: "pv_1",
            sessionId: "sa_1",
            ownershipEpoch: 7,
            lockProviderId: "pv_1",
            lockSessionId: "sa_1",
            windowLabel: "a",
            panes: panes
        ))

        var blocked = basePayload
        blocked["actionable"] = false
        blocked["reason"] = "surface_tombstoned"
        XCTAssertEqual(surfAceAuthorityStateRejectionReason(
            payload: blocked,
            surfaceId: "sf_1",
            providerId: "pv_1",
            sessionId: "sa_1",
            ownershipEpoch: 7,
            lockProviderId: "pv_1",
            lockSessionId: "sa_1",
            windowLabel: "a",
            panes: panes
        ), "surface_tombstoned")
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
    func testPaneChromeIdentityUsesProviderSessionKeyWhenDisplayNameIsAbsent() {
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
