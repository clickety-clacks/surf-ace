import Foundation
import XCTest
@testable import SurfAce

final class SurfAceLocklessContentOperationsTests: XCTestCase {
    func testSetAllocatesIdentityRevisionSequenceAndEntryBoundProvenance() throws {
        var state = try authority()
        let original = try pane(state)

        let result = try SurfAceLocklessContentOperations.set(
            state: &state,
            intent: .init(
                content: markdown("one"),
                contentId: "content-one",
                contentType: "markdown",
                controllerProductName: "  OpenClaw  ",
                friendlyChatName: "  Alpha  ",
                paneId: 1,
                surfaceId: "sf_1"
            )
        )

        let updated = try pane(state)
        XCTAssertEqual(result.currentRevision, 1)
        XCTAssertEqual(result.historyEntryId, updated.history.visible.historyEntryId)
        XCTAssertTrue(try XCTUnwrap(result.historyEntryId).hasPrefix("he_"))
        XCTAssertEqual(updated.history.nextRevision, 2)
        XCTAssertEqual(updated.history.visible.lastVisibleSequence, 2)
        XCTAssertEqual(updated.history.nextVisibleSequence, 3)
        XCTAssertEqual(updated.history.back, [original.history.visible])
        XCTAssertTrue(updated.history.forward.isEmpty)
        XCTAssertEqual(updated.history.visible.provenance.friendlyChatName, "Alpha")
        XCTAssertEqual(updated.history.visible.provenance.controllerProductName, "OpenClaw")
        XCTAssertEqual(state.liveSurfaces["sf_1"]?.surfaceRevision, 1)
    }

    func testSetTruncatesForwardThenBoundsSharedNonVisiblePoolByLRU() throws {
        var state = try authority()
        for index in 0..<22 {
            _ = try SurfAceLocklessContentOperations.set(
                state: &state,
                intent: .init(
                    content: markdown("entry-\(index)"),
                    contentId: "content-\(index)",
                    contentType: "markdown",
                    controllerProductName: index.isMultiple(of: 2) ? "A" : "B",
                    friendlyChatName: nil,
                    paneId: 1,
                    surfaceId: "sf_1"
                )
            )
        }
        var surface = try XCTUnwrap(state.liveSurfaces["sf_1"])
        var target = try XCTUnwrap(surface.panes["1"])
        XCTAssertEqual(target.history.back.count + target.history.forward.count, 20)
        XCTAssertFalse(target.history.back.contains(where: { $0.revision == 0 }))
        XCTAssertFalse(target.history.back.contains(where: { $0.revision == 1 }))

        target.history.forward = [target.history.back.removeLast()]
        surface.panes["1"] = target
        state.liveSurfaces["sf_1"] = surface
        _ = try SurfAceLocklessContentOperations.set(
            state: &state,
            intent: .init(
                content: markdown("replacement"),
                contentId: "replacement",
                contentType: "markdown",
                controllerProductName: nil,
                friendlyChatName: nil,
                paneId: 1,
                surfaceId: "sf_1"
            )
        )
        XCTAssertTrue(try pane(state).history.forward.isEmpty)
    }

    func testAppendIsTerminalOnlyAllocatesClientRevisionAndRejectsStaleAtomically() throws {
        var state = try authority(content: terminal(["one"]), contentId: "terminal", contentType: "terminal")
        let result = try SurfAceLocklessContentOperations.append(
            state: &state,
            surfaceId: "sf_1",
            paneId: 1,
            contentId: "terminal",
            expectedRevision: 0,
            lines: ["two", "three"]
        )
        XCTAssertEqual(result.currentRevision, 1)
        XCTAssertEqual(
            try pane(state).history.visible.content,
            terminal(["one", "two", "three"])
        )

        let before = state
        XCTAssertThrowsError(try SurfAceLocklessContentOperations.append(
            state: &state,
            surfaceId: "sf_1",
            paneId: 1,
            contentId: "terminal",
            expectedRevision: 0,
            lines: ["stale"]
        )) { error in
            XCTAssertEqual(
                error as? SurfAceLocklessContentOperationError,
                .staleContent(currentContentId: "terminal", currentRevision: 1)
            )
        }
        XCTAssertEqual(state, before)
    }

    func testClearMutatesVisibleEntryPreservesProvenanceAndHardClearsAnnotations() throws {
        var state = try authority(content: markdown("one"), contentId: "content", contentType: "markdown")
        var surface = try XCTUnwrap(state.liveSurfaces["sf_1"])
        var target = try XCTUnwrap(surface.panes["1"])
        target.history.visible.annotations = .object(["drawingData": .string("bytes")])
        target.history.visible.provenance = .init(friendlyChatName: "Alpha", controllerProductName: "OpenClaw")
        let historyEntryId = target.history.visible.historyEntryId
        surface.panes["1"] = target
        state.liveSurfaces["sf_1"] = surface

        let result = try SurfAceLocklessContentOperations.clear(
            state: &state,
            surfaceId: "sf_1",
            paneId: 1,
            expectedRevision: 0
        )

        let cleared = try pane(state).history.visible
        XCTAssertNil(result.contentId)
        XCTAssertNil(result.contentType)
        XCTAssertEqual(result.currentRevision, 1)
        XCTAssertEqual(cleared.historyEntryId, historyEntryId)
        XCTAssertEqual(cleared.provenance.friendlyChatName, "Alpha")
        XCTAssertEqual(cleared.annotations, .object([
            "drawingData": .string(""),
            "strokesById": .object([:]),
        ]))
    }

    func testAnnotationGuardAndExactPaneCapacityRejectWithoutMutation() throws {
        var annotating = try authority()
        var surface = try XCTUnwrap(annotating.liveSurfaces["sf_1"])
        surface.panes["1"]?.annotationMode = true
        annotating.liveSurfaces["sf_1"] = surface
        let beforeAnnotation = annotating
        XCTAssertThrowsError(try SurfAceLocklessContentOperations.set(
            state: &annotating,
            intent: .init(
                content: markdown("blocked"), contentId: "blocked", contentType: "markdown",
                controllerProductName: nil, friendlyChatName: nil, paneId: 1, surfaceId: "sf_1"
            )
        )) { error in
            XCTAssertEqual(error as? SurfAceLocklessContentOperationError, .annotationModeActive(1))
        }
        XCTAssertEqual(annotating, beforeAnnotation)

        var bounded = try authority()
        bounded.limits.maxPaneRecoverableStateBytes = 1
        let beforeCapacity = bounded
        XCTAssertThrowsError(try SurfAceLocklessContentOperations.set(
            state: &bounded,
            intent: .init(
                content: markdown("too large"), contentId: "large", contentType: "markdown",
                controllerProductName: nil, friendlyChatName: nil, paneId: 1, surfaceId: "sf_1"
            )
        )) { error in
            guard case .paneStateCapacity(let limit, _, _, let maximum) = error as? SurfAceLocklessContentOperationError else {
                return XCTFail("unexpected error \(error)")
            }
            XCTAssertEqual(limit, "maxPaneRecoverableStateBytes")
            XCTAssertEqual(maximum, 1)
        }
        XCTAssertEqual(bounded, beforeCapacity)
    }

    func testExactPaneAndAnnotationLimitsAcceptEqualityAndRejectOneByteBelow() throws {
        var measured = try authority()
        _ = try SurfAceLocklessContentOperations.set(
            state: &measured,
            intent: .init(
                content: markdown("at limit"), contentId: "at-limit", contentType: "markdown",
                controllerProductName: nil, friendlyChatName: nil, paneId: 1, surfaceId: "sf_1"
            )
        )
        let prospectivePane = try pane(measured)
        let paneBytes = try SurfAceLocklessContentOperations.exactPaneRecoverableBytes(prospectivePane)
        let annotationBytes = try SurfAceLocklessContentOperations.exactAnnotationRestoreBytes(prospectivePane)

        var atLimit = try authority()
        atLimit.limits.maxPaneRecoverableStateBytes = paneBytes
        atLimit.limits.maxPaneAnnotationRestoreBytes = annotationBytes
        XCTAssertNoThrow(try SurfAceLocklessContentOperations.set(
            state: &atLimit,
            intent: .init(
                content: markdown("at limit"), contentId: "at-limit", contentType: "markdown",
                controllerProductName: nil, friendlyChatName: nil, paneId: 1, surfaceId: "sf_1"
            )
        ))

        var paneTooSmall = try authority()
        paneTooSmall.limits.maxPaneRecoverableStateBytes = paneBytes - 1
        let beforePane = paneTooSmall
        XCTAssertThrowsError(try SurfAceLocklessContentOperations.set(
            state: &paneTooSmall,
            intent: .init(
                content: markdown("at limit"), contentId: "at-limit", contentType: "markdown",
                controllerProductName: nil, friendlyChatName: nil, paneId: 1, surfaceId: "sf_1"
            )
        ))
        XCTAssertEqual(paneTooSmall, beforePane)

        var annotationTooSmall = try authority()
        annotationTooSmall.limits.maxPaneAnnotationRestoreBytes = annotationBytes - 1
        let beforeAnnotation = annotationTooSmall
        XCTAssertThrowsError(try SurfAceLocklessContentOperations.set(
            state: &annotationTooSmall,
            intent: .init(
                content: markdown("at limit"), contentId: "at-limit", contentType: "markdown",
                controllerProductName: nil, friendlyChatName: nil, paneId: 1, surfaceId: "sf_1"
            )
        )) { error in
            guard case .paneStateCapacity(let limit, _, _, let maximum) = error as? SurfAceLocklessContentOperationError else {
                return XCTFail("unexpected error \(error)")
            }
            XCTAssertEqual(limit, "maxPaneAnnotationRestoreBytes")
            XCTAssertEqual(maximum, annotationBytes - 1)
        }
        XCTAssertEqual(annotationTooSmall, beforeAnnotation)
    }

    func testPatchPreparationDetectsInterleavingBeforeCommit() throws {
        var state = try authority(
            content: .object(["html": .string("<p>before</p>")]),
            contentId: "html",
            contentType: "html"
        )
        let preparation = try SurfAceLocklessContentOperations.preparePatch(
            state: state,
            surfaceId: "sf_1",
            paneId: 1,
            contentId: "html",
            expectedRevision: 0
        )
        _ = try SurfAceLocklessContentOperations.clear(
            state: &state,
            surfaceId: "sf_1",
            paneId: 1,
            expectedRevision: 0
        )
        let beforeCommit = state
        XCTAssertThrowsError(try SurfAceLocklessContentOperations.commitPatch(
            state: &state,
            preparation: preparation,
            patchedContent: .object(["html": .string("<p>after</p>")])
        )) { error in
            XCTAssertEqual(
                error as? SurfAceLocklessContentOperationError,
                .staleContent(currentContentId: nil, currentRevision: 1)
            )
        }
        XCTAssertEqual(state, beforeCommit)
    }

    private func authority(
        content: SurfAceLocklessJSON = .object(["interactive": .bool(true), "scrollable": .bool(true)]),
        contentId: String? = nil,
        contentType: String? = nil
    ) throws -> SurfAceLocklessAuthorityState {
        var state = try SurfAceLocklessAuthorityState.empty()
        let entry = SurfAceLocklessHistoryEntry(
            annotations: .object(["drawingData": .string(""), "strokesById": .object([:])]),
            content: content,
            contentId: contentId,
            contentType: contentType,
            historyEntryId: "he_initial",
            lastVisibleSequence: 1,
            provenance: .init(friendlyChatName: nil, controllerProductName: nil),
            revision: 0
        )
        let pane = SurfAceLocklessPaneMaterial(
            annotationMode: false,
            history: .init(back: [], forward: [], nextRevision: 1, nextVisibleSequence: 2, visible: entry),
            name: nil,
            paneId: 1,
            paneLabel: 1,
            paneLineageId: "pl_1",
            target: nil
        )
        state.liveSurfaces["sf_1"] = SurfAceLocklessSurfaceMaterial(
            name: "Surf Ace",
            nativeRestoreMaterial: .object([:]),
            nextPaneId: 2,
            nextPaneLabel: 2,
            paneTombstones: [],
            panes: ["1": pane],
            sceneKeys: ["scene"],
            surfaceId: "sf_1",
            surfaceRevision: 0,
            topology: .object(["paneId": .integer(1), "type": .string("pane")]),
            topologyRevision: 0,
            windowLabel: "a"
        )
        return state
    }

    private func pane(_ state: SurfAceLocklessAuthorityState) throws -> SurfAceLocklessPaneMaterial {
        try XCTUnwrap(state.liveSurfaces["sf_1"]?.panes["1"])
    }

    private func markdown(_ value: String) -> SurfAceLocklessJSON {
        .object(["markdown": .string(value)])
    }

    private func terminal(_ lines: [String]) -> SurfAceLocklessJSON {
        .object([
            "lines": .array(lines.map(SurfAceLocklessJSON.string)),
            "scrollback": .integer(0),
        ])
    }
}

extension SurfAceLocklessContentOperationsTests {
    func testACHIST01InterleavedControllersShareOrderedBackForwardHistory() throws {
        var state = try authority()
        for (content, controller) in [("A1", "A"), ("B1", "B"), ("A2", "A")] {
            _ = try SurfAceLocklessContentOperations.set(state: &state, intent: .init(
                content: markdown(content), contentId: content, contentType: "markdown",
                controllerProductName: controller, friendlyChatName: content,
                paneId: 1, surfaceId: "sf_1"
            ))
            XCTAssertEqual(try pane(state).history.visible.contentId, content)
        }
        XCTAssertEqual(try pane(state).history.back.map(\.contentId), [nil, "A1", "B1"])
        XCTAssertEqual(try SurfAceLocklessContentOperations.navigate(
            state: &state, surfaceId: "sf_1", paneId: 1, direction: .back
        )?.contentId, "B1")
        XCTAssertEqual(try SurfAceLocklessContentOperations.navigate(
            state: &state, surfaceId: "sf_1", paneId: 1, direction: .back
        )?.contentId, "A1")
        XCTAssertEqual(try SurfAceLocklessContentOperations.navigate(
            state: &state, surfaceId: "sf_1", paneId: 1, direction: .forward
        )?.contentId, "B1")
        XCTAssertEqual(try SurfAceLocklessContentOperations.navigate(
            state: &state, surfaceId: "sf_1", paneId: 1, direction: .forward
        )?.contentId, "A2")
    }

    func testACHIST02NavigationRecencyControlsSharedTwentyEntryLRU() throws {
        var state = try authority()
        for index in 1...20 {
            _ = try SurfAceLocklessContentOperations.set(state: &state, intent: .init(
                content: markdown("entry-\(index)"), contentId: "entry-\(index)", contentType: "markdown",
                controllerProductName: index.isMultiple(of: 2) ? "B" : "A", friendlyChatName: nil,
                paneId: 1, surfaceId: "sf_1"
            ))
        }
        for _ in 0..<10 {
            _ = try SurfAceLocklessContentOperations.navigate(
                state: &state, surfaceId: "sf_1", paneId: 1, direction: .back
            )
        }
        let refreshed = try pane(state).history.visible.contentId
        for _ in 0..<10 {
            _ = try SurfAceLocklessContentOperations.navigate(
                state: &state, surfaceId: "sf_1", paneId: 1, direction: .forward
            )
        }
        _ = try SurfAceLocklessContentOperations.set(state: &state, intent: .init(
            content: markdown("overflow"), contentId: "overflow", contentType: "markdown",
            controllerProductName: "A", friendlyChatName: nil, paneId: 1, surfaceId: "sf_1"
        ))
        let history = try pane(state).history
        XCTAssertEqual(history.back.count + history.forward.count, 20)
        XCTAssertTrue(history.back.contains { $0.contentId == refreshed })
        XCTAssertEqual(history.visible.contentId, "overflow")
    }

    func testACHIST03BackThenPushClearsForwardIndependentOfController() throws {
        func run(_ controller: String) throws -> SurfAceLocklessHistory {
            var state = try authority()
            for value in ["one", "two"] {
                _ = try SurfAceLocklessContentOperations.set(state: &state, intent: .init(
                    content: markdown(value), contentId: value, contentType: "markdown",
                    controllerProductName: "seed", friendlyChatName: nil, paneId: 1, surfaceId: "sf_1"
                ))
            }
            _ = try SurfAceLocklessContentOperations.navigate(
                state: &state, surfaceId: "sf_1", paneId: 1, direction: .back
            )
            _ = try SurfAceLocklessContentOperations.set(state: &state, intent: .init(
                content: markdown("replacement"), contentId: "replacement", contentType: "markdown",
                controllerProductName: controller, friendlyChatName: nil, paneId: 1, surfaceId: "sf_1"
            ))
            return try pane(state).history
        }
        let a = try run("A")
        let b = try run("B")
        XCTAssertTrue(a.forward.isEmpty)
        XCTAssertTrue(b.forward.isEmpty)
        XCTAssertEqual(a.back.map(\.contentId), b.back.map(\.contentId))
    }

    func testACHIST04NavigationRestoresEntryStateWithoutCursorMovement() throws {
        var state = try authority()
        state.scopes["pane:sf%5F1:1"] = .init(
            cursors: ["A": .init(cursor: 7, gap: nil, gapGeneration: 0)], liveFrames: [:],
            nextSequence: 7, records: [], scopeId: "pane:sf%5F1:1", scopeKind: "pane"
        )
        _ = try SurfAceLocklessContentOperations.set(state: &state, intent: .init(
            content: markdown("one"), contentId: "one", contentType: "markdown",
            controllerProductName: "Clawline", friendlyChatName: "OpenClaw", paneId: 1, surfaceId: "sf_1"
        ))
        var surface = try XCTUnwrap(state.liveSurfaces["sf_1"])
        surface.panes["1"]?.history.visible.annotations = .string("annotation-one")
        state.liveSurfaces["sf_1"] = surface
        let captured = try pane(state).history.visible
        _ = try SurfAceLocklessContentOperations.set(state: &state, intent: .init(
            content: markdown("two"), contentId: "two", contentType: "markdown",
            controllerProductName: "OpenClaw", friendlyChatName: "Other", paneId: 1, surfaceId: "sf_1"
        ))
        let cursor = state.scopes["pane:sf%5F1:1"]?.cursors
        let restored = try SurfAceLocklessContentOperations.navigate(
            state: &state, surfaceId: "sf_1", paneId: 1, direction: .back
        )
        XCTAssertEqual(restored?.content, captured.content)
        XCTAssertEqual(restored?.annotations, captured.annotations)
        XCTAssertEqual(restored?.revision, captured.revision)
        XCTAssertEqual(restored?.provenance, captured.provenance)
        XCTAssertEqual(restored?.historyEntryId, captured.historyEntryId)
        XCTAssertGreaterThan(try XCTUnwrap(restored).lastVisibleSequence, captured.lastVisibleSequence)
        XCTAssertEqual(state.scopes["pane:sf%5F1:1"]?.cursors, cursor)
    }

    func testACHIST05ChattyControllerHasNoHistoryQuotaOrProtection() throws {
        var state = try authority()
        _ = try SurfAceLocklessContentOperations.set(state: &state, intent: .init(
            content: markdown("B-old"), contentId: "B-old", contentType: "markdown",
            controllerProductName: "B", friendlyChatName: nil, paneId: 1, surfaceId: "sf_1"
        ))
        for index in 0..<21 {
            _ = try SurfAceLocklessContentOperations.set(state: &state, intent: .init(
                content: markdown("A-\(index)"), contentId: "A-\(index)", contentType: "markdown",
                controllerProductName: "A", friendlyChatName: nil, paneId: 1, surfaceId: "sf_1"
            ))
        }
        let retained = try pane(state).history.back + pane(state).history.forward
        XCTAssertFalse(retained.contains { $0.contentId == "B-old" })
        XCTAssertEqual(retained.count, 20)
    }
}
