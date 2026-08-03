import Foundation

enum SurfAceLocklessTopologyOperationError: Error, Equatable, Sendable {
    case staleTopology(currentRevision: Int64, currentTopology: SurfAceLocklessJSON)
    case staleSurfaceSet(currentRevision: Int64)
    case surfaceNotFound(String)
    case paneNotFound(Int64)
    case tombstoneNotFound(String)
    case invalidTopology(String)
    case lastLivePane
    case paneCapacity(current: Int64, requested: Int64, maximum: Int64)
    case surfaceStateCapacity(current: Int64, prospective: Int64, maximum: Int64)
    case paneStateCapacity(limit: String, current: Int64, prospective: Int64, maximum: Int64)
    case tombstoneCapacity(bytes: Int64, maximum: Int64)
    case invalidAuthorityState(String)
}

struct SurfAceLocklessTombstoneReclamation: Equatable, Sendable {
    enum Kind: String, Equatable, Sendable { case pane, surface }
    enum Reason: String, Equatable, Sendable { case countCapacity = "count_capacity", byteCapacity = "byte_capacity" }

    var bytes: Int64
    var closedSequence: Int64
    var kind: Kind
    var paneId: Int64?
    var reason: Reason
    var surfaceId: String
    var tombstoneId: String
}

struct SurfAceLocklessPaneSplitResult: Equatable, Sendable {
    var newPaneIds: [Int64]
    var newPaneLabels: [Int64]
    var topology: SurfAceLocklessJSON
    var topologyRevision: Int64
}

struct SurfAceLocklessPaneRenameResult: Equatable, Sendable {
    var name: String?
    var paneId: Int64
    var topologyRevision: Int64
}

struct SurfAceLocklessPaneCloseResult: Equatable, Sendable {
    var closedSequence: Int64
    var paneId: Int64
    var reclamations: [SurfAceLocklessTombstoneReclamation]
    var tombstoneId: String
    var topology: SurfAceLocklessJSON
    var topologyRevision: Int64
}

struct SurfAceLocklessPaneRestoreResult: Equatable, Sendable {
    var paneId: Int64
    var paneLabel: Int64
    var tombstoneId: String
    var topology: SurfAceLocklessJSON
    var topologyRevision: Int64
}

struct SurfAceLocklessDestroyedPaneTombstone: Equatable, Sendable {
    var closedSequence: Int64
    var paneId: Int64
    var tombstoneId: String
}

struct SurfAceLocklessTopologyApplyResult: Equatable, Sendable {
    var createdPaneIds: [Int64]
    var destroyedPaneIds: [Int64]
    var destroyedPaneTombstones: [SurfAceLocklessDestroyedPaneTombstone]
    var panes: [SurfAceLocklessPaneMaterial]
    var preservedPaneIds: [Int64]
    var reclamations: [SurfAceLocklessTombstoneReclamation]
    var topology: SurfAceLocklessJSON
    var topologyRevision: Int64
}

struct SurfAceLocklessSurfaceOpenResult: Equatable, Sendable {
    var surface: SurfAceLocklessSurfaceMaterial
    var surfaceSetRevision: Int64
}

struct SurfAceLocklessSurfaceCloseResult: Equatable, Sendable {
    var closedSequence: Int64
    var reclamations: [SurfAceLocklessTombstoneReclamation]
    var surfaceId: String
    var surfaceSetRevision: Int64
    var tombstoneId: String
}

struct SurfAceLocklessSurfaceRestoreResult: Equatable, Sendable {
    var surface: SurfAceLocklessSurfaceMaterial
    var surfaceSetRevision: Int64
    var tombstoneId: String
}

enum SurfAceLocklessTopologyOperations {
    static func paneSplit(
        state: inout SurfAceLocklessAuthorityState,
        surfaceId: String,
        paneId: Int64,
        count: Int64,
        direction: String,
        expectedTopologyRevision: Int64
    ) throws -> SurfAceLocklessPaneSplitResult {
        try atomically(&state) { candidate in
            guard count >= 2, isDirection(direction) else { throw Error.invalidTopology("pane_split") }
            var surface = try liveSurface(candidate, surfaceId)
            try assertTopology(expectedTopologyRevision, surface)
            guard surface.panes[String(paneId)] != nil else { throw Error.paneNotFound(paneId) }
            let current = Int64(surface.panes.count)
            let prospective = current - 1 + count
            try assertPaneCreation(current: current, prospective: prospective, limits: candidate.limits)

            var children: [SurfAceLocklessJSON] = [.object(["paneId": .integer(paneId), "type": .string("pane")])]
            var newPaneIds: [Int64] = []
            var newPaneLabels: [Int64] = []
            for _ in 1..<count {
                let identity = allocatePaneIdentity(surface: &surface)
                let pane = emptyPane(surfaceId: surfaceId, paneId: identity.id, paneLabel: identity.label)
                surface.panes[String(identity.id)] = pane
                candidate.scopes[paneScopeId(surfaceId, identity.id)] = emptyScope(
                    id: paneScopeId(surfaceId, identity.id), kind: "pane", controllers: candidate.controllers
                )
                newPaneIds.append(identity.id)
                newPaneLabels.append(identity.label)
                children.append(.object(["paneId": .integer(identity.id), "type": .string("pane")]))
            }
            let replacement: SurfAceLocklessJSON = .object([
                "children": .array(children), "direction": .string(direction), "type": .string("split"),
            ])
            guard let topology = replacePane(in: surface.topology, paneId: paneId, with: replacement) else {
                throw Error.invalidTopology("pane_not_in_topology")
            }
            surface.topology = try SurfAceLocklessTopologyCodec.canonical(topology)
            surface.topologyRevision += 1
            surface.surfaceRevision += 1
            try assertRecoverableCapacity(surface, limits: candidate.limits)
            candidate.liveSurfaces[surfaceId] = surface
            return SurfAceLocklessPaneSplitResult(
                newPaneIds: newPaneIds, newPaneLabels: newPaneLabels,
                topology: surface.topology, topologyRevision: surface.topologyRevision
            )
        }
    }

    static func paneRename(
        state: inout SurfAceLocklessAuthorityState,
        surfaceId: String,
        paneId: Int64,
        name: String?,
        expectedTopologyRevision: Int64
    ) throws -> SurfAceLocklessPaneRenameResult {
        try atomically(&state) { candidate in
            var surface = try liveSurface(candidate, surfaceId)
            try assertTopology(expectedTopologyRevision, surface)
            guard var pane = surface.panes[String(paneId)] else { throw Error.paneNotFound(paneId) }
            let current = try paneBytes(pane)
            pane.name = name
            try assertPaneCapacity(current: current, pane: pane, limits: candidate.limits)
            surface.panes[String(paneId)] = pane
            surface.topologyRevision += 1
            surface.surfaceRevision += 1
            try assertSurfaceBaseCapacity(surface, limits: candidate.limits)
            candidate.liveSurfaces[surfaceId] = surface
            return SurfAceLocklessPaneRenameResult(name: name, paneId: paneId, topologyRevision: surface.topologyRevision)
        }
    }

    static func paneClose(
        state: inout SurfAceLocklessAuthorityState,
        surfaceId: String,
        paneId: Int64,
        expectedTopologyRevision: Int64
    ) throws -> SurfAceLocklessPaneCloseResult {
        try atomically(&state) { candidate in
            var surface = try liveSurface(candidate, surfaceId)
            try assertTopology(expectedTopologyRevision, surface)
            guard surface.panes.count > 1 else { throw Error.lastLivePane }
            guard let pane = surface.panes[String(paneId)] else { throw Error.paneNotFound(paneId) }
            guard let topology = removingPane(from: surface.topology, paneId: paneId) else {
                throw Error.invalidTopology("pane_not_in_topology")
            }
            let scopeId = paneScopeId(surfaceId, paneId)
            let scope = candidate.scopes[scopeId] ?? emptyScope(id: scopeId, kind: "pane", controllers: candidate.controllers)
            let sequence = candidate.sequences.nextClosedSequence
            let tombstoneId = tombstoneId(prefix: "pt", sequence: sequence)
            let bytes = try paneTombstoneBytes(
                closedSequence: sequence, pane: pane, scope: scope, tombstoneId: tombstoneId
            )
            guard bytes <= candidate.limits.maxRetainedTombstoneBytes else {
                throw Error.tombstoneCapacity(bytes: bytes, maximum: candidate.limits.maxRetainedTombstoneBytes)
            }
            candidate.sequences.nextClosedSequence += 1
            surface.panes.removeValue(forKey: String(paneId))
            candidate.scopes.removeValue(forKey: scopeId)
            surface.paneTombstones.append(.init(
                bytes: bytes, closedSequence: sequence, pane: pane, scope: scope, tombstoneId: tombstoneId
            ))
            surface.paneTombstones.sort(by: tombstoneOrder)
            surface.topology = try SurfAceLocklessTopologyCodec.canonical(topology)
            surface.topologyRevision += 1
            surface.surfaceRevision += 1
            candidate.liveSurfaces[surfaceId] = surface
            let reclamations = try enforceTombstonePool(&candidate)
            return SurfAceLocklessPaneCloseResult(
                closedSequence: sequence, paneId: paneId, reclamations: reclamations,
                tombstoneId: tombstoneId, topology: surface.topology, topologyRevision: surface.topologyRevision
            )
        }
    }

    static func paneRestore(
        state: inout SurfAceLocklessAuthorityState,
        surfaceId: String,
        tombstoneId: String,
        anchorPaneId: Int64,
        direction: String,
        expectedTopologyRevision: Int64
    ) throws -> SurfAceLocklessPaneRestoreResult {
        try atomically(&state) { candidate in
            guard isDirection(direction) else { throw Error.invalidTopology("pane_restore_direction") }
            var surface = try liveSurface(candidate, surfaceId)
            try assertTopology(expectedTopologyRevision, surface)
            guard surface.panes[String(anchorPaneId)] != nil else { throw Error.paneNotFound(anchorPaneId) }
            guard let index = surface.paneTombstones.firstIndex(where: { $0.tombstoneId == tombstoneId }) else {
                throw Error.tombstoneNotFound(tombstoneId)
            }
            var tombstone = surface.paneTombstones[index]
            guard surface.panes[String(tombstone.pane.paneId)] == nil else {
                throw Error.invalidAuthorityState("restored_pane_identity_live")
            }
            if surface.panes.values.contains(where: { $0.paneLabel == tombstone.pane.paneLabel }) {
                tombstone.pane.paneLabel = allocatePaneLabel(surface: &surface)
            } else {
                surface.nextPaneLabel = max(surface.nextPaneLabel, tombstone.pane.paneLabel + 1)
            }
            let replacement: SurfAceLocklessJSON = .object([
                "children": .array([
                    .object(["paneId": .integer(anchorPaneId), "type": .string("pane")]),
                    .object(["paneId": .integer(tombstone.pane.paneId), "type": .string("pane")]),
                ]),
                "direction": .string(direction), "type": .string("split"),
            ])
            guard let topology = replacePane(in: surface.topology, paneId: anchorPaneId, with: replacement) else {
                throw Error.invalidTopology("anchor_not_in_topology")
            }
            surface.paneTombstones.remove(at: index)
            surface.panes[String(tombstone.pane.paneId)] = tombstone.pane
            candidate.scopes[tombstone.scope.scopeId] = tombstone.scope
            surface.topology = try SurfAceLocklessTopologyCodec.canonical(topology)
            surface.topologyRevision += 1
            surface.surfaceRevision += 1
            candidate.liveSurfaces[surfaceId] = surface
            return SurfAceLocklessPaneRestoreResult(
                paneId: tombstone.pane.paneId, paneLabel: tombstone.pane.paneLabel,
                tombstoneId: tombstoneId, topology: surface.topology, topologyRevision: surface.topologyRevision
            )
        }
    }

    static func topologyApply(
        state: inout SurfAceLocklessAuthorityState,
        surfaceId: String,
        targetPaneId: Int64?,
        desired: SurfAceLocklessJSON,
        allowDestroyPaneIds: [Int64],
        expectedTopologyRevision: Int64
    ) throws -> SurfAceLocklessTopologyApplyResult {
        try atomically(&state) { candidate in
            var surface = try liveSurface(candidate, surfaceId)
            try assertTopology(expectedTopologyRevision, surface)
            let existingIds = Set(surface.panes.values.map(\.paneId))
            var created: [Int64: SurfAceLocklessPaneMaterial] = [:]
            let realizedDesired = try realizeDesired(desired, surfaceId: surfaceId, surface: &surface, created: &created)
            let realized: SurfAceLocklessJSON
            if let targetPaneId {
                guard existingIds.contains(targetPaneId),
                      let replaced = replacePane(in: surface.topology, paneId: targetPaneId, with: realizedDesired) else {
                    throw Error.paneNotFound(targetPaneId)
                }
                realized = replaced
            } else {
                realized = realizedDesired
            }
            let canonical = try SurfAceLocklessTopologyCodec.canonical(realized)
            let resultingList = try SurfAceLocklessTopologyCodec.paneIds(canonical)
            guard Set(resultingList).count == resultingList.count else { throw Error.invalidTopology("duplicate_pane_id") }
            let resultingIds = Set(resultingList)
            let removed = existingIds.subtracting(resultingIds).sorted()
            guard Set(removed).isSubset(of: Set(allowDestroyPaneIds)) else {
                throw Error.invalidTopology("destroy_not_allowed")
            }
            guard resultingIds.allSatisfy({ existingIds.contains($0) || created[$0] != nil }) else {
                throw Error.invalidTopology("caller_selected_pane_id")
            }
            try assertPaneCreation(
                current: Int64(existingIds.count), prospective: Int64(resultingIds.count), limits: candidate.limits
            )
            for pane in created.values { try assertPaneCapacity(current: 0, pane: pane, limits: candidate.limits) }

            var destroyed: [SurfAceLocklessDestroyedPaneTombstone] = []
            for paneId in removed {
                guard let pane = surface.panes.removeValue(forKey: String(paneId)) else { throw Error.paneNotFound(paneId) }
                let scopeId = paneScopeId(surfaceId, paneId)
                let scope = candidate.scopes.removeValue(forKey: scopeId)
                    ?? emptyScope(id: scopeId, kind: "pane", controllers: candidate.controllers)
                let sequence = candidate.sequences.nextClosedSequence
                candidate.sequences.nextClosedSequence += 1
                let id = tombstoneId(prefix: "pt", sequence: sequence)
                let bytes = try paneTombstoneBytes(closedSequence: sequence, pane: pane, scope: scope, tombstoneId: id)
                guard bytes <= candidate.limits.maxRetainedTombstoneBytes else {
                    throw Error.tombstoneCapacity(bytes: bytes, maximum: candidate.limits.maxRetainedTombstoneBytes)
                }
                surface.paneTombstones.append(.init(bytes: bytes, closedSequence: sequence, pane: pane, scope: scope, tombstoneId: id))
                destroyed.append(.init(closedSequence: sequence, paneId: paneId, tombstoneId: id))
            }
            for (paneId, pane) in created where resultingIds.contains(paneId) {
                surface.panes[String(paneId)] = pane
                candidate.scopes[paneScopeId(surfaceId, paneId)] = emptyScope(
                    id: paneScopeId(surfaceId, paneId), kind: "pane", controllers: candidate.controllers
                )
            }
            surface.paneTombstones.sort(by: tombstoneOrder)
            surface.topology = canonical
            surface.topologyRevision += 1
            surface.surfaceRevision += 1
            try assertRecoverableCapacity(surface, limits: candidate.limits)
            candidate.liveSurfaces[surfaceId] = surface
            let reclamations = try enforceTombstonePool(&candidate)
            let panes = surface.panes.values.sorted { $0.paneId < $1.paneId }
            return SurfAceLocklessTopologyApplyResult(
                createdPaneIds: created.keys.filter(resultingIds.contains).sorted(), destroyedPaneIds: removed,
                destroyedPaneTombstones: destroyed, panes: panes,
                preservedPaneIds: existingIds.intersection(resultingIds).sorted(), reclamations: reclamations,
                topology: canonical, topologyRevision: surface.topologyRevision
            )
        }
    }

    static func surfaceWindowOpen(
        state: inout SurfAceLocklessAuthorityState,
        expectedSurfaceSetRevision: Int64,
        placement: SurfAceLocklessJSON? = nil
    ) throws -> SurfAceLocklessSurfaceOpenResult {
        try atomically(&state) { candidate in
            try assertSurfaceSet(expectedSurfaceSetRevision, candidate)
            try assertPaneCreation(current: 0, prospective: 1, limits: candidate.limits)
            let surfaceId = allocateSurfaceId(&candidate)
            let windowLabel = allocateWindowLabel(&candidate)
            let pane = emptyPane(surfaceId: surfaceId, paneId: 1, paneLabel: 1)
            let surface = SurfAceLocklessSurfaceMaterial(
                name: "Surf Ace \(windowLabel.uppercased())",
                nativeRestoreMaterial: .object(["placement": placement ?? .null]),
                nextPaneId: 2, nextPaneLabel: 2, paneTombstones: [], panes: ["1": pane], sceneKeys: [],
                surfaceId: surfaceId, surfaceRevision: 1,
                topology: .object(["paneId": .integer(1), "type": .string("pane")]),
                topologyRevision: 0, windowLabel: windowLabel
            )
            try assertRecoverableCapacity(surface, limits: candidate.limits)
            candidate.liveSurfaces[surfaceId] = surface
            candidate.scopes[surfaceScopeId(surfaceId)] = emptyScope(
                id: surfaceScopeId(surfaceId), kind: "surface", controllers: candidate.controllers
            )
            candidate.scopes[paneScopeId(surfaceId, 1)] = emptyScope(
                id: paneScopeId(surfaceId, 1), kind: "pane", controllers: candidate.controllers
            )
            candidate.surfaceSetRevision += 1
            return .init(surface: surface, surfaceSetRevision: candidate.surfaceSetRevision)
        }
    }

    static func surfaceWindowClose(
        state: inout SurfAceLocklessAuthorityState,
        surfaceId: String,
        expectedSurfaceSetRevision: Int64,
        expectedTopologyRevision: Int64
    ) throws -> SurfAceLocklessSurfaceCloseResult {
        try atomically(&state) { candidate in
            try assertSurfaceSet(expectedSurfaceSetRevision, candidate)
            var surface = try liveSurface(candidate, surfaceId)
            try assertTopology(expectedTopologyRevision, surface)
            surface.sceneKeys.removeAll()
            candidate.sceneSurfaceIds = candidate.sceneSurfaceIds.filter { $0.value != surfaceId }
            var scopes: [String: SurfAceLocklessConsumableScope] = [:]
            for scopeId in [surfaceScopeId(surfaceId)] + surface.panes.values.map({ paneScopeId(surfaceId, $0.paneId) }) {
                if let scope = candidate.scopes.removeValue(forKey: scopeId) { scopes[scopeId] = scope }
            }
            let sequence = candidate.sequences.nextClosedSequence
            candidate.sequences.nextClosedSequence += 1
            let id = tombstoneId(prefix: "st", sequence: sequence)
            let bytes = try surfaceTombstoneBytes(
                closedSequence: sequence, scopes: scopes, surface: surface, tombstoneId: id
            )
            guard bytes <= candidate.limits.maxRetainedTombstoneBytes,
                  bytes <= candidate.limits.maxRecoverableSurfaceBytes else {
                throw Error.invalidAuthorityState("recoverable_surface_envelope")
            }
            candidate.liveSurfaces.removeValue(forKey: surfaceId)
            candidate.surfaceTombstones.append(.init(
                bytes: bytes, closedSequence: sequence, scopes: scopes, surface: surface, tombstoneId: id
            ))
            candidate.surfaceTombstones.sort(by: surfaceTombstoneOrder)
            candidate.surfaceSetRevision += 1
            let reclamations = try enforceTombstonePool(&candidate)
            return .init(
                closedSequence: sequence, reclamations: reclamations, surfaceId: surfaceId,
                surfaceSetRevision: candidate.surfaceSetRevision, tombstoneId: id
            )
        }
    }

    static func surfaceWindowRestore(
        state: inout SurfAceLocklessAuthorityState,
        tombstoneId: String,
        expectedSurfaceSetRevision: Int64,
        placement: SurfAceLocklessJSON? = nil
    ) throws -> SurfAceLocklessSurfaceRestoreResult {
        try atomically(&state) { candidate in
            try assertSurfaceSet(expectedSurfaceSetRevision, candidate)
            guard let index = candidate.surfaceTombstones.firstIndex(where: { $0.tombstoneId == tombstoneId }) else {
                throw Error.tombstoneNotFound(tombstoneId)
            }
            let tombstone = candidate.surfaceTombstones[index]
            guard candidate.liveSurfaces[tombstone.surface.surfaceId] == nil else {
                throw Error.invalidAuthorityState("restored_surface_identity_live")
            }
            var surface = tombstone.surface
            surface.sceneKeys.removeAll()
            if candidate.liveSurfaces.values.contains(where: { $0.windowLabel == surface.windowLabel }) {
                surface.windowLabel = allocateWindowLabel(&candidate)
            }
            if let placement {
                surface.nativeRestoreMaterial = .object(["placement": placement])
            }
            candidate.surfaceTombstones.remove(at: index)
            candidate.liveSurfaces[surface.surfaceId] = surface
            for (scopeId, scope) in tombstone.scopes {
                guard candidate.scopes[scopeId] == nil else { throw Error.invalidAuthorityState("restored_scope_live") }
                candidate.scopes[scopeId] = scope
            }
            candidate.surfaceSetRevision += 1
            return .init(surface: surface, surfaceSetRevision: candidate.surfaceSetRevision, tombstoneId: tombstoneId)
        }
    }
}

private extension SurfAceLocklessTopologyOperations {
    typealias Error = SurfAceLocklessTopologyOperationError

    struct PaneTombstoneEncoding: Codable {
        var closedSequence: Int64; var pane: SurfAceLocklessPaneMaterial
        var scope: SurfAceLocklessConsumableScope; var tombstoneId: String; var version = 1
    }
    struct SurfaceTombstoneEncoding: Codable {
        var closedSequence: Int64; var scopes: [String: SurfAceLocklessConsumableScope]
        var surface: SurfAceLocklessSurfaceMaterial; var tombstoneId: String; var version = 1
    }
    struct Versioned<Value: Codable>: Codable { var value: Value; var version = 1 }
    enum RetainedTombstoneVictim {
        case pane(String, SurfAceLocklessPaneTombstone)
        case surface(SurfAceLocklessSurfaceTombstone)

        var closedSequence: Int64 {
            switch self {
            case .pane(_, let tombstone): tombstone.closedSequence
            case .surface(let tombstone): tombstone.closedSequence
            }
        }
    }

    static func atomically<Result>(
        _ state: inout SurfAceLocklessAuthorityState,
        _ operation: (inout SurfAceLocklessAuthorityState) throws -> Result
    ) throws -> Result {
        var candidate = state
        let result = try operation(&candidate)
        try candidate.validate()
        state = candidate
        return result
    }

    static func liveSurface(_ state: SurfAceLocklessAuthorityState, _ id: String) throws -> SurfAceLocklessSurfaceMaterial {
        guard let surface = state.liveSurfaces[id] else { throw Error.surfaceNotFound(id) }
        return surface
    }
    static func assertTopology(_ expected: Int64, _ surface: SurfAceLocklessSurfaceMaterial) throws {
        guard expected == surface.topologyRevision else {
            throw Error.staleTopology(currentRevision: surface.topologyRevision, currentTopology: surface.topology)
        }
    }
    static func assertSurfaceSet(_ expected: Int64, _ state: SurfAceLocklessAuthorityState) throws {
        guard expected == state.surfaceSetRevision else { throw Error.staleSurfaceSet(currentRevision: state.surfaceSetRevision) }
    }
    static func assertPaneCreation(current: Int64, prospective: Int64, limits: SurfAceLocklessCapacityLimits) throws {
        guard prospective <= limits.maxPanesPerSurface else {
            throw Error.paneCapacity(current: current, requested: prospective, maximum: limits.maxPanesPerSurface)
        }
    }

    static func assertRecoverableCapacity(_ surface: SurfAceLocklessSurfaceMaterial, limits: SurfAceLocklessCapacityLimits) throws {
        try assertSurfaceBaseCapacity(surface, limits: limits)
        for pane in surface.panes.values { try assertPaneCapacity(current: try paneBytes(pane), pane: pane, limits: limits) }
    }
    static func assertSurfaceBaseCapacity(_ surface: SurfAceLocklessSurfaceMaterial, limits: SurfAceLocklessCapacityLimits) throws {
        let base: SurfAceLocklessJSON = .object([
            "name": .string(surface.name), "nativeRestoreMaterial": surface.nativeRestoreMaterial,
            "nextPaneId": .integer(surface.nextPaneId), "nextPaneLabel": .integer(surface.nextPaneLabel),
            "paneIds": .array(surface.panes.values.map(\.paneId).sorted().map(SurfAceLocklessJSON.integer)),
            "sceneKeys": .array(surface.sceneKeys.sorted().map(SurfAceLocklessJSON.string)),
            "surfaceId": .string(surface.surfaceId), "surfaceRevision": .integer(surface.surfaceRevision),
            "topology": surface.topology, "topologyRevision": .integer(surface.topologyRevision),
            "windowLabel": .string(surface.windowLabel),
        ])
        let bytes = try encodedBytes(Versioned(value: base))
        guard bytes <= limits.maxSurfaceRecoverableBaseBytes else {
            throw Error.surfaceStateCapacity(current: bytes, prospective: bytes, maximum: limits.maxSurfaceRecoverableBaseBytes)
        }
    }
    static func assertPaneCapacity(current: Int64, pane: SurfAceLocklessPaneMaterial, limits: SurfAceLocklessCapacityLimits) throws {
        let prospective = try paneBytes(pane)
        let annotations = try encodedBytes(Versioned(value: [pane.history.visible.annotations]
            + pane.history.back.map(\.annotations) + pane.history.forward.map(\.annotations)))
        if annotations > limits.maxPaneAnnotationRestoreBytes {
            throw Error.paneStateCapacity(limit: "maxPaneAnnotationRestoreBytes", current: current, prospective: annotations, maximum: limits.maxPaneAnnotationRestoreBytes)
        }
        if prospective > limits.maxPaneRecoverableStateBytes {
            throw Error.paneStateCapacity(limit: "maxPaneRecoverableStateBytes", current: current, prospective: prospective, maximum: limits.maxPaneRecoverableStateBytes)
        }
    }
    static func paneBytes(_ pane: SurfAceLocklessPaneMaterial) throws -> Int64 { try encodedBytes(Versioned(value: pane)) }
    static func encodedBytes<T: Encodable>(_ value: T) throws -> Int64 {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return Int64(try encoder.encode(value).count)
    }

    static func paneTombstoneBytes(closedSequence: Int64, pane: SurfAceLocklessPaneMaterial, scope: SurfAceLocklessConsumableScope, tombstoneId: String) throws -> Int64 {
        try encodedBytes(PaneTombstoneEncoding(closedSequence: closedSequence, pane: pane, scope: scope, tombstoneId: tombstoneId))
    }
    static func surfaceTombstoneBytes(closedSequence: Int64, scopes: [String: SurfAceLocklessConsumableScope], surface: SurfAceLocklessSurfaceMaterial, tombstoneId: String) throws -> Int64 {
        try encodedBytes(SurfaceTombstoneEncoding(closedSequence: closedSequence, scopes: scopes, surface: surface, tombstoneId: tombstoneId))
    }

    static func emptyPane(surfaceId: String, paneId: Int64, paneLabel: Int64) -> SurfAceLocklessPaneMaterial {
        let lineage = "pl_\(surfaceId)_\(paneId)"
        let entry = SurfAceLocklessHistoryEntry(
            annotations: .object(["drawingData": .string(""), "strokesById": .object([:])]),
            content: .object(["interactive": .bool(true), "scrollable": .bool(true)]),
            contentId: nil, contentType: nil, historyEntryId: "he_\(surfaceId)_\(paneId)_1",
            lastVisibleSequence: 1, provenance: .init(friendlyChatName: nil, controllerProductName: nil), revision: 0
        )
        return .init(
            annotationMode: false,
            history: .init(back: [], forward: [], nextRevision: 1, nextVisibleSequence: 2, visible: entry),
            name: nil, paneId: paneId, paneLabel: paneLabel, paneLineageId: lineage, target: nil
        )
    }
    static func emptyScope(id: String, kind: String, controllers: [String: SurfAceLocklessControllerBundle]) -> SurfAceLocklessConsumableScope {
        let cursors = controllers.keys.reduce(into: [String: SurfAceLocklessConsumableCursor]()) {
            $0[$1] = .init(cursor: 1, gap: nil, gapGeneration: 0)
        }
        return .init(cursors: cursors, liveFrames: [:], nextSequence: 1, records: [], scopeId: id, scopeKind: kind)
    }

    static func allocatePaneIdentity(surface: inout SurfAceLocklessSurfaceMaterial) -> (id: Int64, label: Int64) {
        let retainedIds = Set(surface.paneTombstones.map(\.pane.paneId))
        let liveIds = Set(surface.panes.values.map(\.paneId))
        while retainedIds.contains(surface.nextPaneId) || liveIds.contains(surface.nextPaneId) { surface.nextPaneId += 1 }
        let id = surface.nextPaneId; surface.nextPaneId += 1
        return (id, allocatePaneLabel(surface: &surface))
    }
    static func allocatePaneLabel(surface: inout SurfAceLocklessSurfaceMaterial) -> Int64 {
        let used = Set(surface.panes.values.map(\.paneLabel))
        while used.contains(surface.nextPaneLabel) { surface.nextPaneLabel += 1 }
        let label = surface.nextPaneLabel; surface.nextPaneLabel += 1; return label
    }
    static func allocateSurfaceId(_ state: inout SurfAceLocklessAuthorityState) -> String {
        let retained = Set(state.surfaceTombstones.map(\.surface.surfaceId))
        while true {
            let value = state.sequences.nextSurfaceId; state.sequences.nextSurfaceId += 1
            let id = String(format: "sf_%016llx", value)
            if state.liveSurfaces[id] == nil && !retained.contains(id) { return id }
        }
    }
    static func allocateWindowLabel(_ state: inout SurfAceLocklessAuthorityState) -> String {
        let used = Set(state.liveSurfaces.values.map(\.windowLabel))
        while true {
            let value = state.sequences.nextSurfaceLabel; state.sequences.nextSurfaceLabel += 1
            let label = alphabeticLabel(value)
            if !used.contains(label) { return label }
        }
    }
    static func alphabeticLabel(_ input: Int64) -> String {
        var value = max(input, 1); var characters: [Character] = []
        while value > 0 { value -= 1; characters.append(Character(UnicodeScalar(Int(value % 26) + 97)!)); value /= 26 }
        return String(characters.reversed())
    }
    static func tombstoneId(prefix: String, sequence: Int64) -> String { String(format: "%@_%016llx", prefix, sequence) }
    static func surfaceScopeId(_ surfaceId: String) -> String { "surface:\(scopeEncode(surfaceId))" }
    static func paneScopeId(_ surfaceId: String, _ paneId: Int64) -> String { "pane:\(scopeEncode(surfaceId)):\(paneId)" }
    static func scopeEncode(_ value: String) -> String { value.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? value }
    static func isDirection(_ value: String) -> Bool { value == "horizontal" || value == "vertical" }

    static func replacePane(in node: SurfAceLocklessJSON, paneId: Int64, with replacement: SurfAceLocklessJSON) -> SurfAceLocklessJSON? {
        guard case .object(var object) = node else { return nil }
        if case .string("pane") = object["type"], case .integer(paneId) = object["paneId"] { return replacement }
        guard case .string("split") = object["type"], case .array(let children) = object["children"] else { return nil }
        var replaced = false
        object["children"] = .array(children.map { child in
            guard !replaced, let result = replacePane(in: child, paneId: paneId, with: replacement) else { return child }
            replaced = true; return result
        })
        return replaced ? .object(object) : nil
    }
    static func removingPane(from node: SurfAceLocklessJSON, paneId: Int64) -> SurfAceLocklessJSON? {
        guard case .object(var object) = node else { return node }
        if case .string("pane") = object["type"], case .integer(paneId) = object["paneId"] { return nil }
        guard case .string("split") = object["type"], case .array(let children) = object["children"] else { return node }
        let remaining = children.compactMap { removingPane(from: $0, paneId: paneId) }
        if remaining.count == 1 { return remaining[0] }
        object["children"] = .array(remaining)
        return .object(object)
    }

    static func realizeDesired(
        _ node: SurfAceLocklessJSON,
        surfaceId: String,
        surface: inout SurfAceLocklessSurfaceMaterial,
        created: inout [Int64: SurfAceLocklessPaneMaterial]
    ) throws -> SurfAceLocklessJSON {
        guard case .object(let object) = node, case .string(let type) = object["type"] else {
            throw Error.invalidTopology("desired_node")
        }
        if type == "pane" {
            if case .integer(let explicitId) = object["paneId"] {
                guard surface.panes[String(explicitId)] != nil else { throw Error.invalidTopology("caller_selected_pane_id") }
                return .object(["paneId": .integer(explicitId), "type": .string("pane")])
            }
            let identity = allocatePaneIdentity(surface: &surface)
            var pane = emptyPane(surfaceId: surfaceId, paneId: identity.id, paneLabel: identity.label)
            if case .string(let name) = object["name"] { pane.name = name }
            created[identity.id] = pane
            return .object(["paneId": .integer(identity.id), "type": .string("pane")])
        }
        guard type == "split", case .string(let direction) = object["direction"], isDirection(direction),
              case .array(let children) = object["children"], children.count >= 2 else {
            throw Error.invalidTopology("desired_split")
        }
        return .object([
            "children": .array(try children.map { try realizeDesired($0, surfaceId: surfaceId, surface: &surface, created: &created) }),
            "direction": .string(direction), "type": .string("split"),
        ])
    }

    static func enforceTombstonePool(_ state: inout SurfAceLocklessAuthorityState) throws -> [SurfAceLocklessTombstoneReclamation] {
        var reclamations: [SurfAceLocklessTombstoneReclamation] = []
        while tombstoneCount(state) > state.limits.maxRetainedTombstones
            || tombstoneBytes(state) > state.limits.maxRetainedTombstoneBytes {
            let reason: SurfAceLocklessTombstoneReclamation.Reason = tombstoneCount(state) > state.limits.maxRetainedTombstones
                ? .countCapacity : .byteCapacity
            var victims: [RetainedTombstoneVictim] = state.surfaceTombstones.map(RetainedTombstoneVictim.surface)
            for (surfaceId, surface) in state.liveSurfaces {
                victims.append(contentsOf: surface.paneTombstones.map { RetainedTombstoneVictim.pane(surfaceId, $0) })
            }
            let victim = victims.min { left, right in left.closedSequence < right.closedSequence }
            guard let victim else { throw Error.invalidAuthorityState("tombstone_pool") }
            switch victim {
            case .pane(let surfaceId, let tombstone):
                guard var surface = state.liveSurfaces[surfaceId] else { throw Error.invalidAuthorityState("pane_tombstone_surface") }
                surface.paneTombstones.removeAll { $0.tombstoneId == tombstone.tombstoneId }
                state.liveSurfaces[surfaceId] = surface
                reclamations.append(.init(bytes: tombstone.bytes, closedSequence: tombstone.closedSequence, kind: .pane, paneId: tombstone.pane.paneId, reason: reason, surfaceId: surfaceId, tombstoneId: tombstone.tombstoneId))
            case .surface(let tombstone):
                state.surfaceTombstones.removeAll { $0.tombstoneId == tombstone.tombstoneId }
                state.sceneSurfaceIds = state.sceneSurfaceIds.filter { $0.value != tombstone.surface.surfaceId }
                reclamations.append(.init(bytes: tombstone.bytes, closedSequence: tombstone.closedSequence, kind: .surface, paneId: nil, reason: reason, surfaceId: tombstone.surface.surfaceId, tombstoneId: tombstone.tombstoneId))
            }
        }
        return reclamations
    }
    static func tombstoneCount(_ state: SurfAceLocklessAuthorityState) -> Int64 {
        Int64(state.surfaceTombstones.count + state.liveSurfaces.values.reduce(0) { $0 + $1.paneTombstones.count })
    }
    static func tombstoneBytes(_ state: SurfAceLocklessAuthorityState) -> Int64 {
        state.surfaceTombstones.reduce(0) { $0 + $1.bytes }
            + state.liveSurfaces.values.flatMap(\.paneTombstones).reduce(0) { $0 + $1.bytes }
    }
    static func tombstoneOrder(_ left: SurfAceLocklessPaneTombstone, _ right: SurfAceLocklessPaneTombstone) -> Bool {
        (left.closedSequence, left.tombstoneId) < (right.closedSequence, right.tombstoneId)
    }
    static func surfaceTombstoneOrder(_ left: SurfAceLocklessSurfaceTombstone, _ right: SurfAceLocklessSurfaceTombstone) -> Bool {
        (left.closedSequence, left.tombstoneId) < (right.closedSequence, right.tombstoneId)
    }
}
