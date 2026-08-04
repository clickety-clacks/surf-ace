import Foundation

struct SurfAceLegacyUserDefaultsSnapshot: Equatable, Sendable {
    static let identityMappingKey = "SurfAce.SurfaceIdentityMapping"
    static let surfaceTopologyKey = "SurfAce.SurfaceTopologyMapping"

    var identityMapping: Data?
    var surfaceTopologies: Data?

    init(identityMapping: Data?, surfaceTopologies: Data?) {
        self.identityMapping = identityMapping
        self.surfaceTopologies = surfaceTopologies
    }

    init(userDefaults: UserDefaults) {
        identityMapping = userDefaults.data(forKey: Self.identityMappingKey)
        surfaceTopologies = userDefaults.data(forKey: Self.surfaceTopologyKey)
    }
}

struct SurfAceLegacyProjection: Codable, Equatable, Sendable {
    var identityMapping: Data
    var surfaceTopologies: Data
}

struct SurfAceLocklessRollbackOmission: Codable, Equatable, Sendable {
    var path: String
    var reason: String
}

struct SurfAceLocklessRollbackPreview: Codable, Equatable, Sendable {
    var omissions: [SurfAceLocklessRollbackOmission]
    var projection: SurfAceLegacyProjection
    var sourceGeneration: Int64
}

enum SurfAceLocklessMigrationError: Error, Equatable {
    case invalidLegacyMaterial(String)
    case paneStateCapacity(String)
    case surfaceStateCapacity(String)
}

struct SurfAceLocklessMigration {
    static func migrate(
        _ snapshot: SurfAceLegacyUserDefaultsSnapshot,
        limits: SurfAceLocklessCapacityLimits = .production
    ) throws -> SurfAceLocklessAuthorityState {
        var state = try SurfAceLocklessAuthorityState.empty(limits: limits)
        let identityRoot = try decodeObject(snapshot.identityMapping, missing: ["surfacesBySceneKey": .object([:])])
        let topologyRoot = try decodeObject(snapshot.surfaceTopologies, missing: [:])
        state.sceneSurfaceIds = try parseSceneSurfaceIds(identityRoot)
        let sceneKeysBySurface = Dictionary(grouping: state.sceneSurfaceIds.keys, by: { state.sceneSurfaceIds[$0]! })

        for surfaceId in topologyRoot.keys.sorted() {
            guard case .object(let legacySurface) = topologyRoot[surfaceId] else {
                throw SurfAceLocklessMigrationError.invalidLegacyMaterial("surface:\(surfaceId)")
            }
            let windowLabel = try requiredString(legacySurface["windowLabel"], path: "surface:\(surfaceId)/windowLabel")
            let name = try requiredString(legacySurface["name"], path: "surface:\(surfaceId)/name")
            guard case .array(let legacyPanes) = legacySurface["panes"] else {
                throw SurfAceLocklessMigrationError.invalidLegacyMaterial("surface:\(surfaceId)/panes")
            }
            guard !legacyPanes.isEmpty else {
                throw SurfAceLocklessMigrationError.invalidLegacyMaterial("surface:\(surfaceId)/panes_empty")
            }

            var panes: [String: SurfAceLocklessPaneMaterial] = [:]
            var paneLabels = Set<Int64>()
            var maximumPaneId: Int64 = 0
            var maximumPaneLabel: Int64 = 0
            for (index, legacyPaneValue) in legacyPanes.enumerated() {
                guard case .object(let legacyPane) = legacyPaneValue else {
                    throw SurfAceLocklessMigrationError.invalidLegacyMaterial("surface:\(surfaceId)/panes/\(index)")
                }
                let paneId = try requiredInteger(legacyPane["paneId"], path: "surface:\(surfaceId)/panes/\(index)/paneId")
                let paneLabel = try requiredInteger(legacyPane["paneLabel"], path: "surface:\(surfaceId)/panes/\(index)/paneLabel")
                let lineage = try requiredString(legacyPane["paneLineageId"], path: "surface:\(surfaceId)/panes/\(index)/paneLineageId")
                guard paneId > 0, paneLabel > 0, panes[String(paneId)] == nil, paneLabels.insert(paneLabel).inserted else {
                    throw SurfAceLocklessMigrationError.invalidLegacyMaterial("surface:\(surfaceId)/pane_identity")
                }
                let back = try historyEntries(
                    legacyPane["backStack"],
                    surfaceId: surfaceId,
                    paneId: paneId,
                    branch: "back",
                    firstVisibleSequence: 1
                )
                let forward = try historyEntries(
                    legacyPane["forwardStack"],
                    surfaceId: surfaceId,
                    paneId: paneId,
                    branch: "forward",
                    firstVisibleSequence: Int64(back.count + 1)
                )
                let visibleValue = legacyPane["currentEntry"] ?? emptyLegacyEntry
                let visible = try historyEntry(
                    visibleValue,
                    id: "legacy:\(surfaceId):\(paneId):visible",
                    lastVisibleSequence: Int64(back.count + forward.count + 1)
                )
                let highestRevision = ([visible] + back + forward).map(\.revision).max() ?? 0
                let pane = SurfAceLocklessPaneMaterial(
                    annotationMode: bool(legacyPane["annotationMode"]) ?? false,
                    history: SurfAceLocklessHistory(
                        back: back,
                        forward: forward,
                        nextRevision: highestRevision + 1,
                        nextVisibleSequence: Int64(back.count + forward.count + 2),
                        visible: visible
                    ),
                    name: string(legacyPane["name"]),
                    paneId: paneId,
                    paneLabel: paneLabel,
                    paneLineageId: lineage,
                    target: nullable(legacyPane["currentTarget"])
                )
                try validatePaneBytes(pane, limits: limits, path: "surface:\(surfaceId)/pane:\(paneId)")
                panes[String(paneId)] = pane
                maximumPaneId = max(maximumPaneId, paneId)
                maximumPaneLabel = max(maximumPaneLabel, paneLabel)
            }

            guard Int64(panes.count) <= limits.maxPanesPerSurface + limits.maxRetainedTombstones else {
                throw SurfAceLocklessMigrationError.invalidLegacyMaterial("surface:\(surfaceId)/recoverable_envelope")
            }
            let legacyTopology = legacySurface["paneLayout"] ?? .object(["kind": .string("empty")])
            let topology = try SurfAceLocklessTopologyCodec.canonical(legacyTopology)
            let nativeRestoreMaterial: SurfAceLocklessJSON = .object([
                "legacyPaneLayout": legacyTopology,
                "name": .string(name),
                "windowLabel": .string(windowLabel),
            ])
            let surface = SurfAceLocklessSurfaceMaterial(
                name: name,
                nativeRestoreMaterial: nativeRestoreMaterial,
                nextPaneId: maximumPaneId + 1,
                nextPaneLabel: maximumPaneLabel + 1,
                paneTombstones: [],
                panes: panes,
                sceneKeys: sceneKeysBySurface[surfaceId, default: []].sorted(),
                surfaceId: surfaceId,
                surfaceRevision: 0,
                topology: topology,
                topologyRevision: 0,
                windowLabel: windowLabel
            )
            try validateSurfaceBaseBytes(surface, limits: limits)
            state.liveSurfaces[surfaceId] = surface
            state.scopes["surface:\(percentEncoded(surfaceId))"] = emptyScope(
                id: "surface:\(percentEncoded(surfaceId))",
                kind: "surface"
            )
            for pane in panes.values {
                let scopeId = "pane:\(percentEncoded(surfaceId)):\(pane.paneId)"
                state.scopes[scopeId] = emptyScope(id: scopeId, kind: "pane")
            }
        }
        return try state.validated(for: .legacyMigration)
    }

    static func rollbackPreview(_ state: SurfAceLocklessAuthorityState) throws -> SurfAceLocklessRollbackPreview {
        try state.validate()
        var scenes: [String: SurfAceLocklessJSON] = [:]
        var topologies: [String: SurfAceLocklessJSON] = [:]
        for sceneKey in state.sceneSurfaceIds.keys.sorted() {
            scenes[sceneKey] = .object(["surfaceId": .string(state.sceneSurfaceIds[sceneKey]!)])
        }
        for surface in state.liveSurfaces.values.sorted(by: { $0.surfaceId < $1.surfaceId }) {
            topologies[surface.surfaceId] = try legacySurface(surface)
        }
        var omissions: [SurfAceLocklessRollbackOmission] = [
            .init(path: "/lockless/limits", reason: "legacy_format_has_no_lockless_limits"),
            .init(path: "/lockless/negotiatedModes", reason: "legacy_format_has_no_negotiated_protocol_mode"),
            .init(path: "/lockless/sequences", reason: "legacy_format_has_no_client_allocation_sequences"),
            .init(path: "/lockless/surfaceSetRevision", reason: "legacy_format_has_no_client_surface_set_revision"),
        ]
        for controllerId in state.controllers.keys.sorted() {
            omissions.append(.init(
                path: "/lockless/controllers/\(controllerId)",
                reason: "legacy_format_has_no_controller_bundle"
            ))
            for requestId in state.controllers[controllerId]!.pendingOperationReceipts.keys.sorted() {
                omissions.append(.init(
                    path: "/lockless/controllers/\(controllerId)/pendingOperationReceipts/\(requestId)",
                    reason: "legacy_format_has_no_operation_receipt"
                ))
            }
        }
        for scopeId in state.scopes.keys.sorted() {
            omissions.append(.init(
                path: "/lockless/scopes/\(scopeId)",
                reason: "legacy_format_has_no_authoritative_scope_cursor_or_gap"
            ))
        }
        for key in state.targetApplyWorkItems.keys.sorted() {
            omissions.append(.init(path: "/lockless/targetApplyWorkItems/\(key)", reason: "legacy_format_has_no_target_work"))
        }
        for key in state.targetApplyResults.keys.sorted() {
            omissions.append(.init(path: "/lockless/targetApplyResults/\(key)", reason: "legacy_format_has_no_target_result_truth"))
        }
        for tombstone in state.surfaceTombstones.sorted(by: { $0.closedSequence < $1.closedSequence }) {
            omissions.append(.init(
                path: "/lockless/surfaceTombstones/\(tombstone.tombstoneId)",
                reason: "legacy_format_has_no_recoverable_surface_tombstone"
            ))
        }
        for surface in state.liveSurfaces.values.sorted(by: { $0.surfaceId < $1.surfaceId }) {
            for tombstone in surface.paneTombstones.sorted(by: { $0.closedSequence < $1.closedSequence }) {
                omissions.append(.init(
                    path: "/lockless/liveSurfaces/\(surface.surfaceId)/paneTombstones/\(tombstone.tombstoneId)",
                    reason: "legacy_format_has_no_recoverable_pane_tombstone"
                ))
            }
        }
        omissions.sort { ($0.path, $0.reason) < ($1.path, $1.reason) }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return SurfAceLocklessRollbackPreview(
            omissions: omissions,
            projection: SurfAceLegacyProjection(
                identityMapping: try encoder.encode(SurfAceLocklessJSON.object(["surfacesBySceneKey": .object(scenes)])),
                surfaceTopologies: try encoder.encode(SurfAceLocklessJSON.object(topologies))
            ),
            sourceGeneration: state.generation
        )
    }

    private static var emptyLegacyEntry: SurfAceLocklessJSON {
        .object([
            "drawingData": .string(""),
            "interactive": .bool(true),
            "revision": .integer(0),
            "scrollable": .bool(true),
            "strokesById": .object([:]),
        ])
    }

    private static func decodeObject(
        _ data: Data?,
        missing: [String: SurfAceLocklessJSON]
    ) throws -> [String: SurfAceLocklessJSON] {
        guard let data else { return missing }
        guard case .object(let object) = try JSONDecoder().decode(SurfAceLocklessJSON.self, from: data) else {
            throw SurfAceLocklessMigrationError.invalidLegacyMaterial("root")
        }
        return object
    }

    private static func parseSceneSurfaceIds(_ root: [String: SurfAceLocklessJSON]) throws -> [String: String] {
        guard case .object(let mappings) = root["surfacesBySceneKey"] else {
            throw SurfAceLocklessMigrationError.invalidLegacyMaterial("surfacesBySceneKey")
        }
        var result: [String: String] = [:]
        for sceneKey in mappings.keys.sorted() {
            guard case .object(let identity) = mappings[sceneKey],
                  let surfaceId = string(identity["surfaceId"]), !surfaceId.isEmpty else {
                throw SurfAceLocklessMigrationError.invalidLegacyMaterial("surfacesBySceneKey/\(sceneKey)")
            }
            result[sceneKey] = surfaceId
        }
        return result
    }

    private static func historyEntries(
        _ value: SurfAceLocklessJSON?,
        surfaceId: String,
        paneId: Int64,
        branch: String,
        firstVisibleSequence: Int64
    ) throws -> [SurfAceLocklessHistoryEntry] {
        guard let value else { return [] }
        guard case .array(let entries) = value else {
            throw SurfAceLocklessMigrationError.invalidLegacyMaterial("surface:\(surfaceId)/pane:\(paneId)/\(branch)")
        }
        return try entries.enumerated().map { index, entry in
            try historyEntry(
                entry,
                id: "legacy:\(surfaceId):\(paneId):\(branch):\(index)",
                lastVisibleSequence: firstVisibleSequence + Int64(index)
            )
        }
    }

    private static func historyEntry(
        _ value: SurfAceLocklessJSON,
        id: String,
        lastVisibleSequence: Int64
    ) throws -> SurfAceLocklessHistoryEntry {
        guard case .object(let object) = value else {
            throw SurfAceLocklessMigrationError.invalidLegacyMaterial("history_entry")
        }
        let revision = integer(object["revision"]) ?? 0
        let provenance = SurfAceLocklessEntryProvenance(
            friendlyChatName: string(object["provenanceDisplayName"])
                ?? string(object["provenanceStreamLabel"])
                ?? string(object["provenanceSessionKey"]),
            controllerProductName: string(object["senderDisplayName"])
        )
        let annotationMaterial: SurfAceLocklessJSON = .object([
            "drawingData": object["drawingData"] ?? .string(""),
            "strokesById": object["strokesById"] ?? .object([:]),
        ])
        var contentMaterial = object
        for field in [
            "contentId", "contentType", "drawingData", "provenanceDisplayName",
            "revision", "senderDisplayName", "strokesById",
        ] {
            contentMaterial.removeValue(forKey: field)
        }
        return SurfAceLocklessHistoryEntry(
            annotations: annotationMaterial,
            content: .object(contentMaterial),
            contentId: string(object["contentId"]),
            contentType: string(object["contentType"]),
            historyEntryId: id,
            lastVisibleSequence: lastVisibleSequence,
            provenance: provenance,
            revision: revision
        )
    }

    private static func validatePaneBytes(
        _ pane: SurfAceLocklessPaneMaterial,
        limits: SurfAceLocklessCapacityLimits,
        path: String
    ) throws {
        let bytes = try durableBytes(pane)
        guard bytes <= limits.maxPaneRecoverableStateBytes else {
            throw SurfAceLocklessMigrationError.paneStateCapacity(path)
        }
        let entries = pane.history.back + [pane.history.visible] + pane.history.forward
        let annotationBytes = try durableBytes(entries.map(\.annotations))
        guard annotationBytes <= limits.maxPaneAnnotationRestoreBytes else {
            throw SurfAceLocklessMigrationError.paneStateCapacity("\(path)/annotations")
        }
    }

    private static func validateSurfaceBaseBytes(
        _ surface: SurfAceLocklessSurfaceMaterial,
        limits: SurfAceLocklessCapacityLimits
    ) throws {
        let base: SurfAceLocklessJSON = .object([
            "name": .string(surface.name),
            "nativeRestoreMaterial": surface.nativeRestoreMaterial,
            "nextPaneId": .integer(surface.nextPaneId),
            "nextPaneLabel": .integer(surface.nextPaneLabel),
            "sceneKeys": .array(surface.sceneKeys.map(SurfAceLocklessJSON.string)),
            "surfaceId": .string(surface.surfaceId),
            "surfaceRevision": .integer(surface.surfaceRevision),
            "topology": surface.topology,
            "topologyRevision": .integer(surface.topologyRevision),
            "windowLabel": .string(surface.windowLabel),
        ])
        guard try durableBytes(base) <= limits.maxSurfaceRecoverableBaseBytes else {
            throw SurfAceLocklessMigrationError.surfaceStateCapacity(surface.surfaceId)
        }
    }

    private static func durableBytes<T: Encodable>(_ value: T) throws -> Int64 {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return Int64(try encoder.encode(value).count)
    }

    private static func emptyScope(id: String, kind: String) -> SurfAceLocklessConsumableScope {
        SurfAceLocklessConsumableScope(
            cursors: [:],
            liveFrames: [:],
            nextSequence: 1,
            records: [],
            scopeId: id,
            scopeKind: kind
        )
    }

    private static func legacySurface(_ surface: SurfAceLocklessSurfaceMaterial) throws -> SurfAceLocklessJSON {
        let sortedPanes = surface.panes.values.sorted { $0.paneId < $1.paneId }
        let panes: [SurfAceLocklessJSON] = sortedPanes.map { pane in
            let name = pane.name.map { SurfAceLocklessJSON.string($0) } ?? .null
            let fields: [String: SurfAceLocklessJSON] = [
                "annotationMode": .bool(pane.annotationMode),
                "backStack": .array(pane.history.back.map(legacyEntry)),
                "currentEntry": legacyEntry(pane.history.visible),
                "currentTarget": pane.target ?? .null,
                "forwardStack": .array(pane.history.forward.map(legacyEntry)),
                "name": name,
                "paneId": .integer(pane.paneId),
                "paneLabel": .integer(pane.paneLabel),
                "paneLineageId": .string(pane.paneLineageId),
            ]
            return .object(fields)
        }
        return .object([
            "name": .string(surface.name),
            "paneLayout": try SurfAceLocklessTopologyCodec.legacyProjection(surface.topology),
            "panes": .array(panes),
            "windowLabel": .string(surface.windowLabel),
        ])
    }

    private static func legacyEntry(_ entry: SurfAceLocklessHistoryEntry) -> SurfAceLocklessJSON {
        var object: [String: SurfAceLocklessJSON]
        if case .object(let content) = entry.content {
            if content["payload"] != nil || entry.contentType == nil {
                object = content
            } else {
                var payload = content
                payload["kind"] = entry.contentType.map(SurfAceLocklessJSON.string)
                if let baseURL = payload.removeValue(forKey: "baseUrl") {
                    payload["baseURL"] = baseURL
                }
                object = [
                    "interactive": .bool(true),
                    "payload": .object(payload),
                    "scrollable": .bool(true),
                ]
            }
        } else {
            object = ["payload": entry.content]
        }
        object["interactive"] = object["interactive"] ?? .bool(true)
        object["scrollable"] = object["scrollable"] ?? .bool(true)
        object["contentId"] = entry.contentId.map(SurfAceLocklessJSON.string) ?? .null
        object["contentType"] = entry.contentType.map(SurfAceLocklessJSON.string) ?? .null
        object["revision"] = .integer(entry.revision)
        object["provenanceDisplayName"] = entry.provenance.friendlyChatName.map(SurfAceLocklessJSON.string) ?? .null
        object["senderDisplayName"] = entry.provenance.controllerProductName.map(SurfAceLocklessJSON.string) ?? .null
        if case .object(let annotations) = entry.annotations {
            object["drawingData"] = annotations["drawingData"] ?? .string("")
            object["strokesById"] = annotations["strokesById"] ?? .object([:])
        }
        return .object(object)
    }

    private static func percentEncoded(_ value: String) -> String {
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
        return value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    private static func requiredString(_ value: SurfAceLocklessJSON?, path: String) throws -> String {
        guard let value = string(value), !value.isEmpty else {
            throw SurfAceLocklessMigrationError.invalidLegacyMaterial(path)
        }
        return value
    }

    private static func requiredInteger(_ value: SurfAceLocklessJSON?, path: String) throws -> Int64 {
        guard let value = integer(value) else {
            throw SurfAceLocklessMigrationError.invalidLegacyMaterial(path)
        }
        return value
    }

    private static func nullable(_ value: SurfAceLocklessJSON?) -> SurfAceLocklessJSON? {
        guard let value, value != .null else { return nil }
        return value
    }

    private static func string(_ value: SurfAceLocklessJSON?) -> String? {
        guard case .string(let value) = value else { return nil }
        return value
    }

    private static func integer(_ value: SurfAceLocklessJSON?) -> Int64? {
        guard case .integer(let value) = value else { return nil }
        return value
    }

    private static func bool(_ value: SurfAceLocklessJSON?) -> Bool? {
        guard case .bool(let value) = value else { return nil }
        return value
    }
}
