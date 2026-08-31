import Foundation

enum SurfAceLocklessUIProjection {
    static func topologies(
        from state: SurfAceLocklessAuthorityState
    ) throws -> [String: SurfAcePersistedSurfaceTopology] {
        try state.validate()
        var values: [String: SurfAceLocklessJSON] = [:]
        for surface in state.liveSurfaces.values.sorted(by: { $0.surfaceId < $1.surfaceId }) {
            values[surface.surfaceId] = try surfaceTopology(surface)
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return try JSONDecoder().decode(
            [String: SurfAcePersistedSurfaceTopology].self,
            from: encoder.encode(SurfAceLocklessJSON.object(values))
        )
    }

    private static func surfaceTopology(
        _ surface: SurfAceLocklessSurfaceMaterial
    ) throws -> SurfAceLocklessJSON {
        let panes: [SurfAceLocklessJSON] = surface.panes.values
            .sorted { $0.paneId < $1.paneId }
            .map { pane in
                .object([
                    "annotationMode": .bool(pane.annotationMode),
                    "backStack": .array(pane.history.back.map(entry)),
                    "currentEntry": entry(pane.history.visible),
                    "currentTarget": pane.target ?? .null,
                    "forwardStack": .array(pane.history.forward.map(entry)),
                    "name": pane.name.map(SurfAceLocklessJSON.string) ?? .null,
                    "paneId": .integer(pane.paneId),
                    "paneLabel": .integer(pane.paneLabel),
                    "paneLineageId": .string(pane.paneLineageId),
                ])
            }
        return .object([
            "name": .string(surface.name),
            "paneLayout": try SurfAceLocklessTopologyCodec.persistedProjection(surface.topology),
            "panes": .array(panes),
            "windowLabel": .string(surface.windowLabel),
        ])
    }

    private static func entry(_ value: SurfAceLocklessHistoryEntry) -> SurfAceLocklessJSON {
        var object: [String: SurfAceLocklessJSON]
        if case .object(let content) = value.content {
            if content["payload"] != nil || value.contentType == nil {
                object = content
            } else {
                var payload = content
                payload["kind"] = value.contentType.map(SurfAceLocklessJSON.string)
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
            object = ["payload": value.content]
        }
        object["interactive"] = object["interactive"] ?? .bool(true)
        object["scrollable"] = object["scrollable"] ?? .bool(true)
        object["contentId"] = value.contentId.map(SurfAceLocklessJSON.string) ?? .null
        object["contentType"] = value.contentType.map(SurfAceLocklessJSON.string) ?? .null
        object["revision"] = .integer(value.revision)
        object["provenanceDisplayName"] = value.provenance.friendlyChatName.map(SurfAceLocklessJSON.string) ?? .null
        object["senderDisplayName"] = value.provenance.controllerProductName.map(SurfAceLocklessJSON.string) ?? .null
        if case .object(let annotations) = value.annotations {
            object["drawingData"] = annotations["drawingData"] ?? .string("")
            object["strokesById"] = annotations["strokesById"] ?? .object([:])
        }
        return .object(object)
    }
}
