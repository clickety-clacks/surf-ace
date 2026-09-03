import Foundation
import XCTest
@testable import SurfAce

final class SurfAceAuthorityConformanceVectorTests: XCTestCase {
    private struct VectorSet: Decodable {
        let version: Int
        let source: String
        let vectors: [Vector]
    }

    private struct Vector: Decodable {
        let id: String
        let requirements: [String]
        let contract: String
        let expected: String
        let tokens: [String]?
        let cases: [TargetAdmissionCase]?
    }

    private struct TargetAdmissionCase: Decodable {
        struct Input: Decodable {
            let annotationPolicy: String
            let controllerScenario: String
            let paneLineage: String
            let replaySemantics: String
            let requiredCapability: String
            let surfaceState: String
            let targetPayload: String
        }

        struct Expected: Decodable {
            let materializerCalls: Int
            let notCommitted: Bool
            let receiptDelta: Int
            let receiptSyncOutcome: String
            let resultDelta: Int
            let targetErrorCode: String?
            let topLevelCode: String?
            let workDelta: Int
        }

        let id: String
        let input: Input
        let expected: Expected
    }

    func testCanonicalAuthorityVectorsDecodeWithoutAppleAliasesOrDefaults() throws {
        let resourceURL = try XCTUnwrap(
            Bundle(for: Self.self).url(
                forResource: "authority-conformance",
                withExtension: "json"
            )
        )
        let vectorSet = try JSONDecoder().decode(
            VectorSet.self,
            from: Data(contentsOf: resourceURL)
        )

        XCTAssertEqual(vectorSet.version, 1)
        XCTAssertEqual(
            vectorSet.source,
            "authority-consistency-client-harmonization-omnibus-20260509"
        )
        XCTAssertFalse(vectorSet.vectors.isEmpty)
        XCTAssertEqual(
            Set(vectorSet.vectors.map(\.id)).count,
            vectorSet.vectors.count,
            "canonical authority vector IDs must remain unique"
        )

        for vector in vectorSet.vectors {
            XCTAssertFalse(vector.id.isEmpty)
            XCTAssertFalse(vector.requirements.isEmpty, "\(vector.id) must cite authority")
            XCTAssertFalse(vector.contract.isEmpty, "\(vector.id) must state its contract")
            XCTAssertFalse(vector.expected.isEmpty, "\(vector.id) must state its outcome")
        }
    }

    func testCanonicalVectorPinsCompleteSharedLocklessVocabulary() throws {
        let vectorSet = try loadVectorSet()
        let vector = try XCTUnwrap(
            vectorSet.vectors.first { $0.id == "lockless-cross-language-wire-parity" }
        )

        XCTAssertEqual(vector.requirements, ["COMPAT-5", "AC-MIG-03", "APPLE-AC-10"])
        XCTAssertEqual(vector.tokens, Self.expectedParityTokens)
    }

    func testCanonicalTargetAdmissionCasesExecuteNativeAuthoritySemantics() async throws {
        let vector = try XCTUnwrap(
            loadVectorSet().vectors.first {
                $0.id == "lockless-target-precommit-rejection-classification"
            }
        )
        let cases = try XCTUnwrap(vector.cases)
        XCTAssertEqual(cases.count, 8)

        for testCase in cases {
            let fixture = try makeTargetAdmissionFixture(testCase)
            let adapter = fixture.adapter
            let controllerCount = testCase.input.controllerScenario == "two_same_request_id" ? 2 : 1
            for index in 0..<controllerCount {
                _ = try await adapter.admit(
                    controllerInstanceId: "controller-\(index)",
                    controllerProductName: nil,
                    connectionToken: "connection-\(index)",
                    projectionCapacityBytes: 8 * 1_024 * 1_024,
                    protocolFeatures: [surfAceLocklessCapability]
                )
            }
            let before = await adapter.snapshot()
            let currentLineage = before.liveSurfaces["sf_1"]?.panes["1"]?.paneLineageId
                ?? fixture.currentPaneLineage
            let operationRequestId = testCase.input.controllerScenario == "two_same_request_id"
                ? "operation-shared-controller-scoped"
                : "operation-\(testCase.id)"
            var identities: [SurfAceLocklessTargetOperationIdentity] = []
            var observedTopLevelCodes: [String?] = []
            var observedTargetErrorCodes: [String?] = []
            for index in 0..<controllerCount {
                do {
                    let committed = try await adapter.commitTargetIntent(
                        connectionToken: "connection-\(index)",
                        operationRequestId: operationRequestId,
                        targetRequestId: "target-request-\(testCase.id)-\(index)",
                        surfaceId: "sf_1",
                        targetId: "target-\(testCase.id)-\(index)",
                        targetEpoch: 1,
                        request: targetRequest(testCase, paneLineageId: currentLineage)
                    )
                    identities.append(try XCTUnwrap(committed.targetOperationIdentity))
                    observedTopLevelCodes.append(nil)
                    observedTargetErrorCodes.append(nil)
                } catch let error as SurfAceLocklessRuntimeAdapterError {
                    guard case .targetPrecommit(let code, let targetErrorCode, _) = error else {
                        return XCTFail("\(testCase.id): unexpected error \(error)")
                    }
                    observedTopLevelCodes.append(code)
                    observedTargetErrorCodes.append(targetErrorCode)
                }
            }
            XCTAssertEqual(
                observedTopLevelCodes,
                Array(repeating: testCase.expected.topLevelCode, count: controllerCount),
                testCase.id
            )
            XCTAssertEqual(
                observedTargetErrorCodes,
                Array(repeating: testCase.expected.targetErrorCode, count: controllerCount),
                testCase.id
            )
            let materializerCounter = TargetAdmissionMaterializerCounter()
            for identity in identities {
                _ = try await adapter.materializeTargetWork(identity: identity) { _ in
                    await materializerCounter.increment()
                    return SurfAceLocklessMaterializationOutcome(
                        errorCode: nil,
                        materializedState: .object(["url": .string("https://example.com")]),
                        status: "applied"
                    )
                }
            }
            let after = await adapter.snapshot()
            XCTAssertEqual(
                receiptCount(after) - receiptCount(before),
                testCase.expected.receiptDelta,
                testCase.id
            )
            XCTAssertEqual(
                after.targetApplyWorkItems.count - before.targetApplyWorkItems.count,
                testCase.expected.workDelta,
                testCase.id
            )
            XCTAssertEqual(
                after.targetApplyResults.count - before.targetApplyResults.count,
                testCase.expected.resultDelta,
                testCase.id
            )
            let materializerCalls = await materializerCounter.value
            XCTAssertEqual(
                materializerCalls,
                testCase.expected.materializerCalls,
                testCase.id
            )
            for index in 0..<controllerCount {
                let resolutions = try await adapter.resolveReceipts(
                    connectionToken: "connection-\(index)",
                    requestIds: [operationRequestId]
                )
                guard case .object(let resolution) = try XCTUnwrap(resolutions.first),
                      case .string(let outcome) = resolution["outcome"] else {
                    return XCTFail("\(testCase.id): malformed receipt resolution")
                }
                XCTAssertEqual(outcome, testCase.expected.receiptSyncOutcome, testCase.id)
                XCTAssertEqual(outcome == "not_committed", testCase.expected.notCommitted, testCase.id)
            }
        }
    }

    private func makeTargetAdmissionFixture(
        _ testCase: TargetAdmissionCase
    ) throws -> (
        adapter: SurfAceLocklessRuntimeAdapter,
        currentPaneLineage: String
    ) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceTargetAdmissionVector-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: directory) }
        let store = SurfAceLocklessGenerationStore(
            stateURL: directory.appendingPathComponent("authority-v1.json")
        )
        var state = try SurfAceLocklessAuthorityState.empty()
        let opened = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state,
            expectedSurfaceSetRevision: 0
        )
        let originalId = opened.surface.surfaceId
        var surface = opened.surface
        surface.surfaceId = "sf_1"
        if testCase.input.annotationPolicy == "deny" {
            surface.panes["1"]?.annotationMode = true
        }
        let currentPaneLineage = try XCTUnwrap(surface.panes["1"]?.paneLineageId)
        state.liveSurfaces.removeValue(forKey: originalId)
        state.liveSurfaces["sf_1"] = surface
        let encodedOriginalId = originalId.addingPercentEncoding(
            withAllowedCharacters: .alphanumerics
        ) ?? originalId
        if var scope = state.scopes.removeValue(forKey: "surface:\(encodedOriginalId)") {
            scope.scopeId = "surface:sf%5F1"
            state.scopes[scope.scopeId] = scope
        }
        if var scope = state.scopes.removeValue(forKey: "pane:\(encodedOriginalId):1") {
            scope.scopeId = "pane:sf%5F1:1"
            state.scopes[scope.scopeId] = scope
        }
        if testCase.input.surfaceState == "tombstoned" {
            _ = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
                state: &state,
                surfaceId: "sf_1",
                expectedSurfaceSetRevision: state.surfaceSetRevision,
                expectedTopologyRevision: state.liveSurfaces["sf_1"]?.topologyRevision ?? -1
            )
        }
        try store.save(state)
        return (
            try SurfAceLocklessRuntimeAdapter(store: store),
            currentPaneLineage
        )
    }

    private func targetRequest(
        _ testCase: TargetAdmissionCase,
        paneLineageId: String
    ) -> SurfAceLocklessJSON {
        .object([
            "paneLineageId": .string(
                testCase.input.paneLineage == "current" ? paneLineageId : "pl_stale"
            ),
            "requestId": .string("target-request-\(testCase.id)"),
            "restoreReason": .string("initial"),
            "surfaceId": .string("sf_1"),
            "targetEpoch": .integer(1),
            "targetHeader": .object([
                "replaySemantics": .string(testCase.input.replaySemantics),
                "requiredCapabilities": .array([.string(
                    testCase.input.requiredCapability == "supported"
                        ? "target.browser_url.v1"
                        : "target.missing.v1"
                )]),
            ]),
            "targetId": .string("target-\(testCase.id)"),
            "targetKind": .string("browser_url"),
            "targetPayload": .object([
                "url": .string(
                    testCase.input.targetPayload == "safe_https"
                        ? "https://example.com"
                        : "file:///etc/passwd"
                ),
            ]),
        ])
    }

    private func receiptCount(_ state: SurfAceLocklessAuthorityState) -> Int {
        state.controllers.values.reduce(0) {
            $0 + $1.pendingOperationReceipts.count
        }
    }

    private func loadVectorSet() throws -> VectorSet {
        let resourceURL = try XCTUnwrap(
            Bundle(for: Self.self).url(
                forResource: "authority-conformance",
                withExtension: "json"
            )
        )
        return try JSONDecoder().decode(VectorSet.self, from: Data(contentsOf: resourceURL))
    }

    private static let expectedParityTokens = [
        "surf-ace.lockless-multi-controller.v1",
        "maxPanesPerSurface",
        "maxSurfaceRecoverableBaseBytes",
        "maxPaneRecoverableStateBytes",
        "maxPaneAnnotationRestoreBytes",
        "maxRetainedTombstones",
        "maxRetainedTombstoneBytes",
        "maxRecoverableSurfaceBytes",
        "maxPaneConsumableRecords",
        "maxPaneConsumableBytes",
        "maxSurfaceConsumableRecords",
        "maxSurfaceConsumableBytes",
        "maxConsumableRecordBytes",
        "maxConsumableCursorStateBytesPerScope",
        "maxAdmittedControllerEntries",
        "maxDormantControllerEntries",
        "maxDormantControllerBytes",
        "maxPendingOperationReceiptsPerController",
        "maxPendingOperationReceiptBytesPerController",
        "resolved_success",
        "resolved_failure",
        "not_committed",
        "still_pending",
        "receipt_unavailable",
        "source_overflow",
        "scope_capacity",
        "record_oversize",
        "cursor",
        "gapGeneration",
        "intent_committed",
        "materializing",
        "terminal",
        "commitSequence",
        "receipt_capacity",
        "surface_state_capacity",
        "materialization_outcome_unknown",
    ]
}

private actor TargetAdmissionMaterializerCounter {
    private(set) var value = 0

    func increment() {
        value += 1
    }
}
