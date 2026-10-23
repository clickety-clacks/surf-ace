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

struct SurfAceLocklessTombstoneReclamation: Codable, Equatable, Sendable {
    enum Kind: String, Codable, Equatable, Sendable { case pane, surface }
    enum Reason: String, Codable, Equatable, Sendable { case countCapacity = "count_capacity", byteCapacity = "byte_capacity" }

    var bytes: Int64
    var closedSequence: Int64
    var commitSequence: Int64
    var deliveredControllerInstanceIds: [String]
    var eventId: String
    var kind: Kind
    var maxRetainedTombstoneBytes: Int64
    var maxRetainedTombstones: Int64
    var nestedLivePaneCount: Int64
    var nestedPaneTombstoneCount: Int64
    var paneId: Int64?
    var reason: Reason
    var recipientControllerInstanceIds: [String]
    var surfaceId: String
    var tombstoneId: String
    var unreadBytesDiscarded: Int64
    var unreadFrameCount: Int64
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
    // Validate the complete assignment before publishing any changed label.
    static func applyWindowLabels(
        state: inout SurfAceLocklessAuthorityState,
        assignments: [(surfaceId: String, windowLabel: String)]
    ) throws {
        try atomically(&state) { candidate in
            var labels: [String: String] = [:]
            for assignment in assignments {
                guard !assignment.windowLabel.isEmpty,
                      assignment.windowLabel.utf8.allSatisfy({ $0 >= 97 && $0 <= 122 }),
                      labels[assignment.surfaceId] == nil else {
                    throw Error.invalidTopology("window_label")
                }
                _ = try liveSurface(candidate, assignment.surfaceId)
                labels[assignment.surfaceId] = assignment.windowLabel
            }
            var used = Set<String>()
            for surface in candidate.liveSurfaces.values {
                let label = labels[surface.surfaceId] ?? surface.windowLabel
                guard used.insert(label).inserted else {
                    throw Error.invalidTopology("duplicate_window_label")
                }
            }
            for (surfaceId, label) in labels {
                candidate.liveSurfaces[surfaceId]?.windowLabel = label
                candidate.liveSurfaces[surfaceId]?.windowLabelConfirmed = true
            }
        }
    }

    static func paneSplit(
        state: inout SurfAceLocklessAuthorityState,
        surfaceId: String,
        paneId: Int64,
        count: Int64,
        direction: String,
        expectedTopologyRevision: Int64,
        assignedPaneLabels: [Int64: Int64]? = nil,
        assignedPaneLineages: [Int64: String]? = nil
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
                let label = assignedPaneLabels?[identity] ?? 0
                guard label >= 0 else { throw Error.invalidTopology("allocator_pane_assignment_invalid") }
                let pane = emptyPane(surfaceId: surfaceId, paneId: identity, paneLabel: label,
                    paneLineageId: assignedPaneLineages?[identity])
                surface.panes[String(identity)] = pane
                candidate.scopes[paneScopeId(surfaceId, identity)] = emptyScope(
                    id: paneScopeId(surfaceId, identity), kind: "pane", controllers: candidate.controllers
                )
                newPaneIds.append(identity)
                newPaneLabels.append(label)
                children.append(.object(["paneId": .integer(identity), "type": .string("pane")]))
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
            pane.name = name
            surface.panes[String(paneId)] = pane
            surface.topologyRevision += 1
            surface.surfaceRevision += 1
            candidate.liveSurfaces[surfaceId] = surface
            return SurfAceLocklessPaneRenameResult(name: name, paneId: paneId, topologyRevision: surface.topologyRevision)
        }
    }

    static func paneClose(
        state: inout SurfAceLocklessAuthorityState,
        surfaceId: String,
        paneId: Int64,
        expectedTopologyRevision: Int64,
        origin: SurfAceLocklessTombstoneOrigin = .ambiguous
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
            let bytes: Int64 = 0
            candidate.sequences.nextClosedSequence += 1
            surface.panes.removeValue(forKey: String(paneId))
            candidate.scopes.removeValue(forKey: scopeId)
            surface.paneTombstones.append(.init(
                bytes: bytes, closedSequence: sequence, origin: origin,
                pane: pane, scope: scope, tombstoneId: tombstoneId
            ))
            surface.paneTombstones.sort(by: tombstoneOrder)
            surface.topology = try SurfAceLocklessTopologyCodec.canonical(topology)
            surface.topologyRevision += 1
            surface.surfaceRevision += 1
            candidate.liveSurfaces[surfaceId] = surface
            let reclamations: [SurfAceLocklessTombstoneReclamation] = []
            return SurfAceLocklessPaneCloseResult(
                closedSequence: sequence, paneId: paneId, reclamations: reclamations,
                tombstoneId: tombstoneId, topology: surface.topology, topologyRevision: surface.topologyRevision
            )
        }
    }

    static func paneFinalClose(
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
            guard candidate.sequences.nextClosedSequence < Int64.max else {
                throw Error.invalidAuthorityState("close_sequence_exhausted")
            }

            let closedSequence = candidate.sequences.nextClosedSequence
            let recordId = tombstoneId(prefix: "pf", sequence: closedSequence)
            let topologyRevision = surface.topologyRevision + 1
            surface.panes.removeValue(forKey: String(paneId))
            surface.paneTombstones.removeAll { $0.pane.paneId == paneId }
            surface.topology = try SurfAceLocklessTopologyCodec.canonical(topology)
            surface.topologyRevision = topologyRevision
            surface.surfaceRevision += 1
            candidate.sequences.nextClosedSequence += 1
            preservePaneScope(pane, surfaceId: surfaceId, state: &candidate)
            appendFinalCloseAllocation(
                state: &candidate,
                allocationKind: .pane,
                surfaceId: surfaceId,
                pane: pane,
                surface: surface,
                closedSequence: closedSequence,
                recordId: recordId,
                sourceTombstoneId: recordId,
                sourceTombstoneKind: .pane,
                closeTopologyRevision: topologyRevision,
                terminalRetirementRevision: topologyRevision
            )
            if var publisher = candidate.annotationPublisher {
                try publisher.finalizePane(surfaceId: surfaceId, paneId: Int(paneId))
                candidate.annotationPublisher = publisher
            }
            candidate.liveSurfaces[surfaceId] = surface
            return SurfAceLocklessPaneCloseResult(
                closedSequence: closedSequence,
                paneId: paneId,
                reclamations: [],
                tombstoneId: recordId,
                topology: surface.topology,
                topologyRevision: topologyRevision
            )
        }
    }

    static func paneRestore(
        state: inout SurfAceLocklessAuthorityState,
        surfaceId: String,
        tombstoneId: String,
        anchorPaneId: Int64,
        direction: String,
        expectedTopologyRevision: Int64,
        assignedPaneLabel: Int64
    ) throws -> SurfAceLocklessPaneRestoreResult {
        try atomically(&state) { candidate in
            guard isDirection(direction) else { throw Error.invalidTopology("pane_restore_direction") }
            var surface = try liveSurface(candidate, surfaceId)
            try assertTopology(expectedTopologyRevision, surface)
            guard surface.panes[String(anchorPaneId)] != nil else { throw Error.paneNotFound(anchorPaneId) }
            guard let index = surface.paneTombstones.firstIndex(where: { $0.tombstoneId == tombstoneId }) else {
                throw Error.tombstoneNotFound(tombstoneId)
            }
            guard assignedPaneLabel >= 0 else {
                throw Error.invalidTopology("allocator_pane_assignment_invalid")
            }
            var tombstone = surface.paneTombstones[index]
            tombstone.pane.paneLabel = assignedPaneLabel
            guard surface.panes[String(tombstone.pane.paneId)] == nil else {
                throw Error.invalidAuthorityState("restored_pane_identity_live")
            }
            guard assignedPaneLabel == 0 || !surface.panes.values.contains(where: { $0.paneLabel == assignedPaneLabel }) else {
                throw Error.invalidAuthorityState("restored_pane_label_conflict")
            }
            if assignedPaneLabel > 0 {
                surface.nextPaneLabel = max(surface.nextPaneLabel, assignedPaneLabel + 1)
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
        expectedTopologyRevision: Int64,
        assignedPaneLabels: [Int64: Int64]? = nil,
        assignedPaneLineages: [Int64: String]? = nil
    ) throws -> SurfAceLocklessTopologyApplyResult {
        try atomically(&state) { candidate in
            var surface = try liveSurface(candidate, surfaceId)
            try assertTopology(expectedTopologyRevision, surface)
            let existingIds = Set(surface.panes.values.map(\.paneId))
            var created: [Int64: SurfAceLocklessPaneMaterial] = [:]
            let realizedDesired = try realizeDesired(desired, surfaceId: surfaceId, surface: &surface,
                created: &created, assignedPaneLabels: assignedPaneLabels,
                assignedPaneLineages: assignedPaneLineages)
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

            var destroyed: [SurfAceLocklessDestroyedPaneTombstone] = []
            for paneId in removed {
                guard let pane = surface.panes.removeValue(forKey: String(paneId)) else { throw Error.paneNotFound(paneId) }
                let scopeId = paneScopeId(surfaceId, paneId)
                let scope = candidate.scopes.removeValue(forKey: scopeId)
                    ?? emptyScope(id: scopeId, kind: "pane", controllers: candidate.controllers)
                let sequence = candidate.sequences.nextClosedSequence
                candidate.sequences.nextClosedSequence += 1
                let id = tombstoneId(prefix: "pt", sequence: sequence)
                let bytes: Int64 = 0
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
            candidate.liveSurfaces[surfaceId] = surface
            let reclamations: [SurfAceLocklessTombstoneReclamation] = []
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
            let pane = emptyPane(surfaceId: surfaceId, paneId: 1, paneLabel: 0)
            let surface = SurfAceLocklessSurfaceMaterial(
                name: "Surf Ace \(windowLabel.uppercased())",
                nativeRestoreMaterial: .object(["placement": placement ?? .null]),
                nextPaneId: 2, nextPaneLabel: 1, paneTombstones: [], panes: ["1": pane], sceneKeys: [],
                surfaceId: surfaceId, surfaceRevision: 1,
                topology: .object(["paneId": .integer(1), "type": .string("pane")]),
                topologyRevision: 0, windowLabel: windowLabel, windowLabelConfirmed: false
            )
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
        expectedTopologyRevision: Int64,
        origin: SurfAceLocklessTombstoneOrigin = .ambiguous
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
            let bytes: Int64 = 0
            candidate.liveSurfaces.removeValue(forKey: surfaceId)
            candidate.surfaceTombstones.append(.init(
                bytes: bytes, closedSequence: sequence, origin: origin,
                scopes: scopes, surface: surface, tombstoneId: id
            ))
            candidate.surfaceTombstones.sort(by: surfaceTombstoneOrder)
            candidate.surfaceSetRevision += 1
            let reclamations: [SurfAceLocklessTombstoneReclamation] = []
            return .init(
                closedSequence: sequence, reclamations: reclamations, surfaceId: surfaceId,
                surfaceSetRevision: candidate.surfaceSetRevision, tombstoneId: id
            )
        }
    }

    static func surfaceWindowFinalClose(
        state: inout SurfAceLocklessAuthorityState,
        surfaceId: String,
        expectedSurfaceSetRevision: Int64,
        expectedTopologyRevision: Int64
    ) throws -> SurfAceLocklessSurfaceCloseResult {
        try atomically(&state) { candidate in
            try assertSurfaceSet(expectedSurfaceSetRevision, candidate)
            let surface = try liveSurface(candidate, surfaceId)
            try assertTopology(expectedTopologyRevision, surface)
            guard candidate.sequences.nextClosedSequence < Int64.max else {
                throw Error.invalidAuthorityState("close_sequence_exhausted")
            }

            let closedSequence = candidate.sequences.nextClosedSequence
            let recordId = tombstoneId(prefix: "sf", sequence: closedSequence)
            let terminalRevision = candidate.surfaceSetRevision + 1
            let allPaneTombstones = Dictionary(
                surface.paneTombstones.map { ($0.pane.paneId, $0) },
                uniquingKeysWith: { first, _ in first }
            )
            var paneIds = Set(surface.panes.values.map(\.paneId))
            paneIds.formUnion(allPaneTombstones.keys)

            preserveSurfaceScopes(surface, state: &candidate)
            for paneId in paneIds.sorted() {
                let pane = surface.panes[String(paneId)] ?? allPaneTombstones[paneId]?.pane
                guard let pane else { continue }
                let paneRecordId = tombstoneId(prefix: "pf", sequence: closedSequence)
                    + "_\(paneId)"
                appendFinalCloseAllocation(
                    state: &candidate,
                    allocationKind: .pane,
                    surfaceId: surfaceId,
                    pane: pane,
                    surface: surface,
                    closedSequence: closedSequence,
                    recordId: paneRecordId,
                    sourceTombstoneId: allPaneTombstones[paneId]?.tombstoneId ?? paneRecordId,
                    sourceTombstoneKind: .pane,
                    closeTopologyRevision: surface.topologyRevision,
                    terminalRetirementRevision: terminalRevision
                )
            }
            appendFinalCloseAllocation(
                state: &candidate,
                allocationKind: .surface,
                surfaceId: surfaceId,
                pane: nil,
                surface: surface,
                closedSequence: closedSequence,
                recordId: recordId,
                sourceTombstoneId: recordId,
                sourceTombstoneKind: .surface,
                closeTopologyRevision: surface.topologyRevision,
                terminalRetirementRevision: terminalRevision
            )
            if var publisher = candidate.annotationPublisher {
                publisher.finalizeSurface(surfaceId: surfaceId)
                candidate.annotationPublisher = publisher
            }
            candidate.sequences.nextClosedSequence += 1
            candidate.sceneSurfaceIds = candidate.sceneSurfaceIds.filter { $0.value != surfaceId }
            candidate.liveSurfaces.removeValue(forKey: surfaceId)
            candidate.surfaceSetRevision = terminalRevision
            return SurfAceLocklessSurfaceCloseResult(
                closedSequence: closedSequence,
                reclamations: [],
                surfaceId: surfaceId,
                surfaceSetRevision: terminalRevision,
                tombstoneId: recordId
            )
        }
    }

    private static func preservePaneScope(
        _ pane: SurfAceLocklessPaneMaterial,
        surfaceId: String,
        state: inout SurfAceLocklessAuthorityState
    ) {
        let scopeId = paneScopeId(surfaceId, pane.paneId)
        if state.scopes[scopeId] == nil {
            state.scopes[scopeId] = emptyScope(
                id: scopeId, kind: "pane", controllers: state.controllers
            )
        }
    }

    private static func preserveSurfaceScopes(
        _ surface: SurfAceLocklessSurfaceMaterial,
        state: inout SurfAceLocklessAuthorityState
    ) {
        let surfaceId = surface.surfaceId
        let surfaceScope = surfaceScopeId(surfaceId)
        if state.scopes[surfaceScope] == nil {
            state.scopes[surfaceScope] = emptyScope(
                id: surfaceScope, kind: "surface", controllers: state.controllers
            )
        }
        for pane in surface.panes.values {
            preservePaneScope(pane, surfaceId: surfaceId, state: &state)
        }
        for tombstone in surface.paneTombstones {
            let scopeId = paneScopeId(surfaceId, tombstone.pane.paneId)
            if state.scopes[scopeId] == nil { state.scopes[scopeId] = tombstone.scope }
        }
    }

    private static func appendFinalCloseAllocation(
        state: inout SurfAceLocklessAuthorityState,
        allocationKind: SurfAceLocklessFinalCloseRecord.AllocationKind,
        surfaceId: String,
        pane: SurfAceLocklessPaneMaterial?,
        surface: SurfAceLocklessSurfaceMaterial,
        closedSequence: Int64,
        recordId: String,
        sourceTombstoneId: String,
        sourceTombstoneKind: SurfAceLocklessTombstoneReclamation.Kind,
        closeTopologyRevision: Int64,
        terminalRetirementRevision: Int64
    ) {
        let binding = state.registryBinding
        let confirmedWindowLabel = surface.windowLabel.isEmpty || surface.windowLabelConfirmed == false
            ? nil : surface.windowLabel
        let confirmedPaneLabel = pane.flatMap { $0.paneLabel > 0 ? $0.paneLabel : nil }
        let allocationGeneration = allocationKind == .pane
            ? pane?.allocationGeneration : surface.allocationGeneration
        let record = SurfAceLocklessFinalCloseRecord(
            allocationGeneration: allocationGeneration,
            allocationKind: allocationKind,
            allocatorId: binding?.allocatorId,
            clientId: binding?.clientId,
            closedSequence: closedSequence,
            closeTopologyRevision: closeTopologyRevision,
            fleetId: binding?.fleetId,
            paneId: allocationKind == .pane ? pane?.paneId : nil,
            paneLabel: allocationKind == .pane ? confirmedPaneLabel : nil,
            paneLineageId: allocationKind == .pane ? pane?.paneLineageId : nil,
            recordId: recordId,
            sourceTombstoneId: sourceTombstoneId,
            sourceTombstoneKind: sourceTombstoneKind,
            surfaceId: surfaceId,
            terminalRetirementRevision: terminalRetirementRevision,
            windowLabel: allocationKind == .surface ? confirmedWindowLabel : nil
        )
        var records = state.terminalCloseRecords ?? []
        records.append(record)
        state.terminalCloseRecords = records

        let hasAllocation = allocationKind == .pane ? confirmedPaneLabel != nil : confirmedWindowLabel != nil
        guard hasAllocation else { return }
        let intent = SurfAceLocklessAllocationReleaseIntent(
            allocationGeneration: allocationGeneration,
            allocationKind: allocationKind,
            allocatorId: binding?.allocatorId,
            clientId: binding?.clientId,
            closeTopologyRevision: closeTopologyRevision,
            fleetId: binding?.fleetId,
            idempotencyKey: "release:\(recordId)",
            paneId: allocationKind == .pane ? pane?.paneId : nil,
            paneLabel: allocationKind == .pane ? confirmedPaneLabel : nil,
            paneLineageId: allocationKind == .pane ? pane?.paneLineageId : nil,
            recordId: recordId,
            sourceTombstoneId: sourceTombstoneId,
            sourceTombstoneKind: sourceTombstoneKind,
            status: .pending,
            surfaceId: surfaceId,
            terminalRetirementRevision: terminalRetirementRevision,
            windowLabel: allocationKind == .surface ? confirmedWindowLabel : nil
        )
        var intents = state.allocationReleaseIntents ?? []
        intents.append(intent)
        state.allocationReleaseIntents = intents
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
                surface.windowLabelConfirmed = false
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

    static func surfaceBaseBytes(_ surface: SurfAceLocklessSurfaceMaterial) throws -> Int64 {
        try encodedBytes(Versioned(value: surfaceBaseMaterial(surface)))
    }

    static func restoredSurfaceTombstoneBytes(
        closedSequence: Int64,
        scopes: [String: SurfAceLocklessConsumableScope],
        surface: SurfAceLocklessSurfaceMaterial,
        tombstoneId: String
    ) throws -> Int64 {
        try surfaceTombstoneBytes(
            closedSequence: closedSequence,
            scopes: scopes,
            surface: surface,
            tombstoneId: tombstoneId
        )
    }

    static func restoredPaneTombstoneBytes(
        closedSequence: Int64,
        pane: SurfAceLocklessPaneMaterial,
        scope: SurfAceLocklessConsumableScope,
        tombstoneId: String
    ) throws -> Int64 {
        try paneTombstoneBytes(
            closedSequence: closedSequence,
            pane: pane,
            scope: scope,
            tombstoneId: tombstoneId
        )
    }

    static func validateRestoredRecoverableState(
        _ state: SurfAceLocklessAuthorityState
    ) throws {
        for (surfaceId, surface) in state.liveSurfaces {
            guard surfaceId == surface.surfaceId else {
                throw SurfAceLocklessAuthorityError.invalidState("surface_key")
            }
            try validateRestoredSurface(surface, limits: state.limits, path: "live_surface:\(surfaceId)")
        }

        for tombstone in state.surfaceTombstones {
            try validateRestoredSurface(tombstone.surface, limits: state.limits,
                                        path: "surface_tombstone:\(tombstone.tombstoneId)")
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

    static func surfaceBaseMaterial(_ surface: SurfAceLocklessSurfaceMaterial) -> SurfAceLocklessJSON {
        .object([
            "name": .string(surface.name), "nativeRestoreMaterial": surface.nativeRestoreMaterial,
            "nextPaneId": .integer(surface.nextPaneId), "nextPaneLabel": .integer(surface.nextPaneLabel),
            "paneIds": .array(surface.panes.values.map(\.paneId).sorted().map(SurfAceLocklessJSON.integer)),
            "sceneKeys": .array(surface.sceneKeys.sorted().map(SurfAceLocklessJSON.string)),
            "surfaceId": .string(surface.surfaceId), "surfaceRevision": .integer(surface.surfaceRevision),
            "topology": surface.topology, "topologyRevision": .integer(surface.topologyRevision),
            "windowLabel": .string(surface.windowLabel),
        ])
    }
    static func encodedBytes<T: Encodable>(_ value: T) throws -> Int64 {
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        return Int64(try encoder.encode(value).count)
    }

    static func paneTombstoneBytes(closedSequence: Int64, pane: SurfAceLocklessPaneMaterial, scope: SurfAceLocklessConsumableScope, tombstoneId: String) throws -> Int64 {
        0
    }
    static func surfaceTombstoneBytes(closedSequence: Int64, scopes: [String: SurfAceLocklessConsumableScope], surface: SurfAceLocklessSurfaceMaterial, tombstoneId: String) throws -> Int64 {
        0
    }

    static func validateRestoredSurface(
        _ surface: SurfAceLocklessSurfaceMaterial,
        limits: SurfAceLocklessCapacityLimits,
        path: String
    ) throws {

    }

    static func saturatingAdd(_ left: Int64, _ right: Int64) -> Int64 {
        let (sum, overflow) = left.addingReportingOverflow(right)
        return overflow ? .max : sum
    }

    static func emptyPane(surfaceId: String, paneId: Int64, paneLabel: Int64,
                          paneLineageId: String? = nil) -> SurfAceLocklessPaneMaterial {
        let lineage = paneLineageId ?? "pl_\(surfaceId)_\(paneId)"
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

    static func allocatePaneIdentity(surface: inout SurfAceLocklessSurfaceMaterial) -> Int64 {
        let retainedIds = Set(surface.paneTombstones.map(\.pane.paneId))
        let liveIds = Set(surface.panes.values.map(\.paneId))
        while retainedIds.contains(surface.nextPaneId) || liveIds.contains(surface.nextPaneId) { surface.nextPaneId += 1 }
        let id = surface.nextPaneId; surface.nextPaneId += 1
        return id
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
        if remaining.count == 1 {
            guard case .object(var survivor) = remaining[0] else { return remaining[0] }
            // The surviving node now occupies this split's slot in its parent.
            // Its former weight was relative to its removed siblings, not to
            // the parent's other children.
            survivor["weight"] = object["weight"]
            return .object(survivor)
        }
        object["children"] = .array(remaining)
        return .object(object)
    }

    static func realizeDesired(
        _ node: SurfAceLocklessJSON,
        surfaceId: String,
        surface: inout SurfAceLocklessSurfaceMaterial,
        created: inout [Int64: SurfAceLocklessPaneMaterial],
        assignedPaneLabels: [Int64: Int64]? = nil,
        assignedPaneLineages: [Int64: String]? = nil
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
            let label = assignedPaneLabels?[identity] ?? 0
            guard label >= 0 else { throw Error.invalidTopology("allocator_pane_assignment_invalid") }
            var pane = emptyPane(surfaceId: surfaceId, paneId: identity, paneLabel: label,
                paneLineageId: assignedPaneLineages?[identity])
            if case .string(let name) = object["name"] { pane.name = name }
            created[identity] = pane
            return .object(["paneId": .integer(identity), "type": .string("pane")])
        }
        guard type == "split", case .string(let direction) = object["direction"], isDirection(direction),
              case .array(let children) = object["children"], children.count >= 2 else {
            throw Error.invalidTopology("desired_split")
        }
        return .object([
            "children": .array(try children.map { try realizeDesired($0, surfaceId: surfaceId,
                surface: &surface, created: &created, assignedPaneLabels: assignedPaneLabels,
                assignedPaneLineages: assignedPaneLineages) }),
            "direction": .string(direction), "type": .string("split"),
        ])
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
