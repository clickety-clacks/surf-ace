import Foundation
import XCTest

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

    func testCanonicalVectorPinsTargetPrecommitRejectionClassification() throws {
        let vector = try XCTUnwrap(
            loadVectorSet().vectors.first {
                $0.id == "lockless-target-precommit-rejection-classification"
            }
        )

        XCTAssertEqual(vector.requirements, ["APPLE-AC-10", "CORR-05", "CORR09-F1"])
        XCTAssertEqual(vector.tokens, [
            "unsupported_operation",
            "invalid_payload",
            "capability_missing",
            "pane_lineage_missing",
            "policy_denied",
            "unsafe_payload",
            "not_committed",
        ])
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
        "legacy_overflow",
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
