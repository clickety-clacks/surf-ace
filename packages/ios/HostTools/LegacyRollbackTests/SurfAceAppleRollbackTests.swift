import Foundation
import XCTest

final class SurfAceAppleRollbackTests: XCTestCase {
    func testPreviewIsStableNonmutatingAndProjectsRepresentableMaterialWithoutOwner() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let before = try SurfAceAppleRollback.manifest(fixture.source)

        let first = try SurfAceAppleRollback.preview(
            sourceContainer: fixture.source,
            priorApplicationArtifact: fixture.priorApp
        )
        let second = try SurfAceAppleRollback.preview(
            sourceContainer: fixture.source,
            priorApplicationArtifact: fixture.priorApp
        )

        XCTAssertEqual(first, second)
        XCTAssertEqual(try SurfAceAppleRollback.manifest(fixture.source), before)
        XCTAssertEqual(first.authorityGeneration, 7)
        XCTAssertTrue(first.legacyPreview.omissions.contains {
            $0.path == "/lockless/controllers/controller-a"
        })
        let projected = try XCTUnwrap(
            JSONSerialization.jsonObject(with: first.legacyPreview.projection.surfaceTopologies) as? [String: Any]
        )
        let projectedKeys = allKeys(projected)
        XCTAssertTrue(Set(["owner", "ownershipEpoch", "providerId", "sessionId"]).isDisjoint(with: projectedKeys))
        let surface = try XCTUnwrap(projected["sf_1"] as? [String: Any])
        let panes = try XCTUnwrap(surface["panes"] as? [[String: Any]])
        XCTAssertEqual(panes.first?["paneId"] as? Int, 7)
        XCTAssertEqual(
            (panes.first?["currentEntry"] as? [String: Any])?["contentId"] as? String,
            "ct_00000001"
        )
    }

    func testApplyMutatesOnlyExactCopyAndRestoreRecoversOriginalFileBytes() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let preview = try SurfAceAppleRollback.preview(
            sourceContainer: fixture.source,
            priorApplicationArtifact: fixture.priorApp
        )
        try FileManager.default.copyItem(at: fixture.source, to: fixture.copy)
        let sourceBefore = try SurfAceAppleRollback.manifest(fixture.source)
        XCTAssertEqual(try SurfAceAppleRollback.manifest(fixture.copy), sourceBefore)

        let apply = try SurfAceAppleRollback.apply(
            preview: preview,
            sourceContainer: fixture.source,
            containerCopy: fixture.copy,
            priorApplicationArtifact: fixture.priorApp
        )

        XCTAssertEqual(try SurfAceAppleRollback.manifest(fixture.source), sourceBefore)
        XCTAssertNotEqual(apply.appliedContainerManifest, sourceBefore)
        let preferencesURL = fixture.copy.appendingPathComponent(SurfAceAppleRollback.preferencesRelativePath)
        let preferencesData = try Data(contentsOf: preferencesURL)
        let preferences = try XCTUnwrap(
            PropertyListSerialization.propertyList(from: preferencesData, format: nil) as? [String: Any]
        )
        XCTAssertEqual(preferences["Unrelated.Preference"] as? String, "preserved")
        XCTAssertEqual(
            preferences[SurfAceLegacyUserDefaultsSnapshot.identityMappingKey] as? Data,
            preview.legacyPreview.projection.identityMapping
        )
        XCTAssertEqual(
            preferences[SurfAceLegacyUserDefaultsSnapshot.surfaceTopologyKey] as? Data,
            preview.legacyPreview.projection.surfaceTopologies
        )
        let sourceAuthority = fixture.source.appendingPathComponent(SurfAceAppleRollback.defaultAuthorityRelativePath)
        let copyAuthority = fixture.copy.appendingPathComponent(SurfAceAppleRollback.defaultAuthorityRelativePath)
        XCTAssertEqual(try Data(contentsOf: copyAuthority), try Data(contentsOf: sourceAuthority))

        let restored = try SurfAceAppleRollback.restore(
            preview: preview,
            sourceContainer: fixture.source,
            containerCopy: fixture.copy,
            priorApplicationArtifact: fixture.priorApp
        )
        XCTAssertEqual(restored, sourceBefore)
        XCTAssertEqual(try SurfAceAppleRollback.manifest(fixture.copy), sourceBefore)
    }

    func testApplyRequiresAnUntouchedOperatorSuppliedCopyAndRetainedPriorApp() throws {
        let fixture = try makeFixture()
        defer { try? FileManager.default.removeItem(at: fixture.root) }
        let preview = try SurfAceAppleRollback.preview(
            sourceContainer: fixture.source,
            priorApplicationArtifact: fixture.priorApp
        )
        try FileManager.default.copyItem(at: fixture.source, to: fixture.copy)
        try Data("changed".utf8).write(to: fixture.copy.appendingPathComponent("mutation"))

        XCTAssertThrowsError(try SurfAceAppleRollback.apply(
            preview: preview,
            sourceContainer: fixture.source,
            containerCopy: fixture.copy,
            priorApplicationArtifact: fixture.priorApp
        )) { error in
            XCTAssertEqual(error as? SurfAceAppleRollbackError, .containerIdentityMismatch)
        }
        XCTAssertThrowsError(try SurfAceAppleRollback.apply(
            preview: preview,
            sourceContainer: fixture.source,
            containerCopy: fixture.source,
            priorApplicationArtifact: fixture.priorApp
        )) { error in
            XCTAssertEqual(error as? SurfAceAppleRollbackError, .containerCopyMustDifferFromSource)
        }
    }

    private struct Fixture {
        var copy: URL
        var priorApp: URL
        var root: URL
        var source: URL
    }

    private func makeFixture() throws -> Fixture {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent("SurfAceAppleRollbackTests-\(UUID().uuidString)", isDirectory: true)
        let source = root.appendingPathComponent("original-container", isDirectory: true)
        let copy = root.appendingPathComponent("rollback-copy", isDirectory: true)
        let priorApp = root.appendingPathComponent("SurfAce-approved-legacy.app", isDirectory: true)
        try FileManager.default.createDirectory(at: source, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: priorApp, withIntermediateDirectories: true)
        try Data("approved legacy bytes".utf8).write(to: priorApp.appendingPathComponent("SurfAce"))

        var state = try SurfAceLocklessMigration.migrate(legacySnapshot())
        state.generation = 7
        state.controllers["controller-a"] = SurfAceLocklessControllerBundle(
            controllerInstanceId: "controller-a",
            controllerProductName: "surf-ace",
            disconnectedAt: 10,
            dormantSequence: 1,
            pendingOperationReceipts: [:],
            projectionCapacityBytes: 8 * 1_024 * 1_024,
            status: .dormant
        )
        let authorityURL = source.appendingPathComponent(SurfAceAppleRollback.defaultAuthorityRelativePath)
        try SurfAceLocklessGenerationStore(stateURL: authorityURL).save(state)

        let preferencesURL = source.appendingPathComponent(SurfAceAppleRollback.preferencesRelativePath)
        try FileManager.default.createDirectory(
            at: preferencesURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        let oldPreferences: [String: Any] = [
            "Unrelated.Preference": "preserved",
            SurfAceLegacyUserDefaultsSnapshot.identityMappingKey: Data("old identity".utf8),
            SurfAceLegacyUserDefaultsSnapshot.surfaceTopologyKey: Data("old topology".utf8),
        ]
        try PropertyListSerialization.data(
            fromPropertyList: oldPreferences,
            format: .binary,
            options: 0
        ).write(to: preferencesURL)
        return Fixture(copy: copy, priorApp: priorApp, root: root, source: source)
    }

    private func legacySnapshot() throws -> SurfAceLegacyUserDefaultsSnapshot {
        let identity: [String: Any] = [
            "surfacesBySceneKey": ["scene-1": ["surfaceId": "sf_1"]],
        ]
        let entry: [String: Any] = [
            "contentId": "ct_00000001",
            "contentType": "markdown",
            "drawingData": "",
            "interactive": true,
            "payload": ["kind": "markdown", "markdown": "current"],
            "revision": 2,
            "scrollable": true,
            "strokesById": [:],
        ]
        let topology: [String: Any] = [
            "sf_1": [
                "name": "Surf Ace",
                "paneLayout": ["kind": "leaf", "paneId": 7],
                "panes": [[
                    "annotationMode": false,
                    "backStack": [],
                    "currentEntry": entry,
                    "forwardStack": [],
                    "paneId": 7,
                    "paneLabel": 2,
                    "paneLineageId": "pl_7",
                ]],
                "windowLabel": "a",
            ],
        ]
        return SurfAceLegacyUserDefaultsSnapshot(
            identityMapping: try JSONSerialization.data(withJSONObject: identity, options: [.sortedKeys]),
            surfaceTopologies: try JSONSerialization.data(withJSONObject: topology, options: [.sortedKeys])
        )
    }

    private func allKeys(_ value: Any) -> Set<String> {
        if let object = value as? [String: Any] {
            return object.reduce(into: Set(object.keys)) { result, entry in
                result.formUnion(allKeys(entry.value))
            }
        }
        if let array = value as? [Any] {
            return array.reduce(into: []) { $0.formUnion(allKeys($1)) }
        }
        return []
    }
}
