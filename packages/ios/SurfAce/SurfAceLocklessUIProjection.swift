import Foundation

enum SurfAceLocklessUIProjection {
    static func topologies(
        from state: SurfAceLocklessAuthorityState
    ) throws -> [String: SurfAcePersistedSurfaceTopology] {
        // Authority is validated at its ordered durable commit/load boundary.
        // Projection reads typed material; it does not serialize every window.
        return try Dictionary(uniqueKeysWithValues: state.liveSurfaces.values.map { surface in
            (surface.surfaceId, try SurfAcePersistedSurfaceTopology(projecting: surface))
        })
    }

    static func paneEntry(_ value: SurfAceLocklessHistoryEntry) throws -> SurfAcePaneEntry {
        let object = try object(entry(value))
        let payload: SurfAceFramePayload?
        if let raw = object["payload"], raw != .null {
            let fields = try Self.object(raw)
            switch try string(fields["kind"]) {
            case "html": payload = .html(html: try string(fields["html"]), baseURL: try optionalString(fields["baseURL"]))
            case "image": payload = .image(data: try string(fields["data"]), mediaType: try string(fields["mediaType"]), alt: try optionalString(fields["alt"]))
            case "pdf": payload = .pdf(data: try string(fields["data"]))
            case "terminal":
                guard case .array(let lines) = fields["lines"] else { throw invalid() }
                payload = .terminal(lines: try lines.map { try string($0) }, scrollback: try integer(fields["scrollback"]))
            case "markdown": payload = .markdown(markdown: try string(fields["markdown"]))
            case "video": payload = .video(url: try string(fields["url"]))
            case "canvas": payload = .canvas(color: try optionalString(fields["color"]), grid: try optionalBool(fields["grid"]) ?? false)
            case "browserURL": payload = .browserURL(url: try string(fields["url"]), allowedSnapshotFallback: try optionalBool(fields["allowedSnapshotFallback"]), fallbackSnapshotTargetId: try optionalString(fields["fallbackSnapshotTargetId"]))
            default: throw invalid()
            }
        } else { payload = nil }
        var strokes: [String: SurfAceStroke] = [:]
        if let raw = object["strokesById"] {
            for (key, rawStroke) in try Self.object(raw) {
                let stroke = try Self.object(rawStroke)
                guard case .array(let points) = stroke["points"] else { throw invalid() }
                strokes[key] = SurfAceStroke(strokeId: try string(stroke["strokeId"]), points: try points.map { raw in
                    let point = try Self.object(raw)
                    guard let x = number(point["x"]), let y = number(point["y"]),
                          case .integer(let timestamp) = point["timestamp"] else { throw invalid() }
                    return SurfAceStrokePoint(x: x, y: y, pressure: number(point["pressure"]), timestamp: timestamp)
                }, tool: try string(stroke["tool"]))
            }
        }
        guard let drawing = Data(base64Encoded: try string(object["drawingData"])) else { throw invalid() }
        let reload: SurfAceContentReloadSource?
        if let raw = object["reloadSource"], raw != .null {
            let fields = try Self.object(raw)
            reload = .init(kind: try string(fields["kind"]), path: try string(fields["path"]))
        } else { reload = nil }
        let contentType: SurfAceContentType?
        if let raw = value.contentType {
            guard let parsed = SurfAceContentType(rawValue: raw) else { throw invalid() }
            contentType = parsed
        } else { contentType = nil }
        return SurfAcePaneEntry(contentId: value.contentId, revision: try integer(.integer(value.revision)),
            historyOwnerToken: try optionalString(object["historyOwnerToken"]),
            contentType: contentType, payload: payload,
            reloadSource: reload, title: try optionalString(object["title"]),
            senderDisplayName: try optionalString(object["senderDisplayName"]),
            provenanceDisplayName: value.provenance.friendlyChatName,
            provenanceSessionKey: try optionalString(object["provenanceSessionKey"]),
            provenanceSource: try optionalString(object["provenanceSource"]),
            provenanceAgentId: try optionalString(object["provenanceAgentId"]),
            provenanceStreamLabel: try optionalString(object["provenanceStreamLabel"]),
            provenancePushedAt: try optionalString(object["provenancePushedAt"]),
            provenanceControllerProductName: value.provenance.controllerProductName,
            scrollable: try optionalBool(object["scrollable"]) ?? true,
            interactive: try optionalBool(object["interactive"]) ?? true,
            url: try optionalString(object["url"]), drawingData: drawing, strokesById: strokes)
    }

    static func target(_ value: SurfAceLocklessJSON?) throws -> SurfAcePaneTargetState? {
        guard let value, value != .null else { return nil }
        let fields = try object(value)
        return .init(targetId: try string(fields["targetId"]), targetKind: try string(fields["targetKind"]),
            paneLineageId: try string(fields["paneLineageId"]), targetEpoch: try integer(fields["targetEpoch"]),
            restorePolicy: try string(fields["restorePolicy"]), currentState: try string(fields["currentState"]),
            targetHeader: fields["targetHeader"].map(foundation) as? [String: Any],
            targetPayload: fields["targetPayload"].map(foundation) as? [String: Any],
            lastApplyEvidence: fields["lastApplyEvidence"].map(foundation) as? [String: Any])
    }

    private static func invalid() -> SurfAceLocklessAuthorityError { .invalidState("ui_projection_material") }
    private static func object(_ value: SurfAceLocklessJSON) throws -> [String: SurfAceLocklessJSON] {
        guard case .object(let fields) = value else { throw invalid() }; return fields
    }
    private static func string(_ value: SurfAceLocklessJSON?) throws -> String {
        guard case .string(let text) = value else { throw invalid() }; return text
    }
    private static func optionalString(_ value: SurfAceLocklessJSON?) throws -> String? {
        guard let value, value != .null else { return nil }
        return try string(value)
    }
    private static func integer(_ value: SurfAceLocklessJSON?) throws -> Int {
        guard case .integer(let number) = value, let result = Int(exactly: number) else { throw invalid() }; return result
    }
    private static func optionalBool(_ value: SurfAceLocklessJSON?) throws -> Bool? {
        guard let value, value != .null else { return nil }
        guard case .bool(let result) = value else { throw invalid() }; return result
    }
    private static func number(_ value: SurfAceLocklessJSON?) -> Double? {
        switch value { case .double(let n): return n; case .integer(let n): return Double(n); default: return nil }
    }
    private static func foundation(_ value: SurfAceLocklessJSON) -> Any {
        switch value {
        case .array(let values): return values.map(foundation)
        case .object(let fields): return fields.mapValues(foundation)
        case .bool(let v): return v
        case .double(let v): return v
        case .integer(let v): return v
        case .string(let v): return v
        case .null: return NSNull()
        }
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
        object["provenanceControllerProductName"] = value.provenance.controllerProductName.map(SurfAceLocklessJSON.string) ?? .null
        if case .object(let annotations) = value.annotations {
            object["drawingData"] = annotations["drawingData"] ?? .string("")
            object["strokesById"] = annotations["strokesById"] ?? .object([:])
        }
        return .object(object)
    }
}

// Ephemeral rendering material only. Durable authority remains in the coordinator.
// Value-semantic source equality includes history, annotations, lineage and target;
// a revision number alone cannot safely identify unchanged annotation material.
struct SurfAceLocklessUIProjectionCache {
    private struct PaneProjection {
        var source: SurfAceLocklessPaneMaterial
        var topology: SurfAcePersistedPaneTopology
    }
    private var panesBySurface: [String: [String: PaneProjection]] = [:]

    mutating func topologies(
        from state: SurfAceLocklessAuthorityState,
        surfaceIds: Set<String>
    ) throws -> [String: SurfAcePersistedSurfaceTopology] {
        var next: [String: [String: PaneProjection]] = [:]
        var result: [String: SurfAcePersistedSurfaceTopology] = [:]
        for surfaceId in surfaceIds.sorted() {
            guard let surface = state.liveSurfaces[surfaceId] else { continue }
            var projected: [String: PaneProjection] = [:]
            var panes: [SurfAcePersistedPaneTopology] = []
            for source in surface.panes.values.sorted(by: { $0.paneId < $1.paneId }) {
                let key = String(source.paneId)
                let pane: PaneProjection
                if let prior = panesBySurface[surfaceId]?[key], prior.source == source {
                    pane = prior
                } else {
                    pane = .init(source: source, topology: try .init(projecting: source))
                }
                projected[key] = pane
                panes.append(pane.topology)
            }
            result[surfaceId] = try .init(projecting: surface, projectedPanes: panes)
            next[surfaceId] = projected
        }
        // Publish the cache only after every requested surface converted successfully;
        // prune unmounted/closed panes instead of retaining obsolete render material.
        panesBySurface = next
        return result
    }
}

private extension SurfAcePersistedPaneTopology {
    init(projecting pane: SurfAceLocklessPaneMaterial) throws {
        annotationMode = pane.annotationMode
        backStack = try pane.history.back.map(SurfAceLocklessUIProjection.paneEntry)
        currentEntry = try SurfAceLocklessUIProjection.paneEntry(pane.history.visible)
        currentTarget = try SurfAceLocklessUIProjection.target(pane.target)
        forwardStack = try pane.history.forward.map(SurfAceLocklessUIProjection.paneEntry)
        guard let id = Int(exactly: pane.paneId), let label = Int(exactly: pane.paneLabel) else {
            throw SurfAceLocklessAuthorityError.invalidState("ui_projection_identity")
        }
        paneId = id; paneLabel = label; paneLineageId = pane.paneLineageId; name = pane.name
    }
}

private extension SurfAcePersistedSurfaceTopology {
    init(projecting surface: SurfAceLocklessSurfaceMaterial,
         projectedPanes: [SurfAcePersistedPaneTopology]? = nil) throws {
        windowLabel = surface.windowLabel; name = surface.name
        paneLayout = try persistedPaneLayout(fromCanonical: surface.topology)
        if let projectedPanes { panes = projectedPanes }
        else { panes = try surface.panes.values.sorted { $0.paneId < $1.paneId }.map { try .init(projecting: $0) } }
    }
}
