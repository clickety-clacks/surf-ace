import Foundation
import Darwin
import Network

private struct SurfAceLossyArray<Element: Decodable>: Decodable {
    let values: [Element]
    let discardedCount: Int

    init(from decoder: Decoder) throws {
        var container = try decoder.unkeyedContainer()
        var values: [Element] = []
        var discardedCount = 0
        while !container.isAtEnd {
            let elementDecoder = try container.superDecoder()
            if let value = try? Element(from: elementDecoder) {
                values.append(value)
            } else {
                discardedCount += 1
            }
        }
        self.values = values
        self.discardedCount = discardedCount
    }
}

private func decodeTolerantly<T: Decodable, Key: CodingKey>(
    _ type: T.Type,
    from container: KeyedDecodingContainer<Key>,
    forKey key: Key
) -> (value: T?, malformed: Bool) {
    guard container.contains(key) else { return (nil, false) }
    do {
        return (try container.decodeIfPresent(T.self, forKey: key), false)
    } catch {
        return (nil, true)
    }
}

struct SurfAceRegistrationSurface: Codable, Equatable, Sendable {
    struct Pane: Codable, Equatable, Sendable {
        let paneId: String
        let paneLineageId: String
        let paneLabel: Int64
        let allocationGeneration: Int64?
        let allocationGenerationWasMalformed: Bool

        private enum CodingKeys: String, CodingKey {
            case paneId, paneLineageId, paneLabel, allocationGeneration
        }

        init(
            paneId: String,
            paneLineageId: String,
            paneLabel: Int64,
            allocationGeneration: Int64? = nil,
            allocationGenerationWasMalformed: Bool = false
        ) {
            self.paneId = paneId
            self.paneLineageId = paneLineageId
            self.paneLabel = paneLabel
            self.allocationGeneration = allocationGeneration
            self.allocationGenerationWasMalformed = allocationGenerationWasMalformed
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            paneId = try container.decode(String.self, forKey: .paneId)
            paneLineageId = try container.decode(String.self, forKey: .paneLineageId)
            paneLabel = try container.decode(Int64.self, forKey: .paneLabel)
            if container.contains(.allocationGeneration) {
                do {
                    allocationGeneration = try container.decodeIfPresent(Int64.self, forKey: .allocationGeneration)
                    allocationGenerationWasMalformed = false
                } catch {
                    allocationGeneration = nil
                    allocationGenerationWasMalformed = true
                }
            } else {
                allocationGeneration = nil
                allocationGenerationWasMalformed = false
            }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(paneId, forKey: .paneId)
            try container.encode(paneLineageId, forKey: .paneLineageId)
            try container.encode(paneLabel, forKey: .paneLabel)
            try container.encodeIfPresent(allocationGeneration, forKey: .allocationGeneration)
        }
    }
    let surfaceId: String
    let panes: [Pane]
    let windowGeneration: Int64?

    init(surfaceId: String, panes: [Pane], windowGeneration: Int64? = nil) {
        self.surfaceId = surfaceId
        self.panes = panes
        self.windowGeneration = windowGeneration
    }

    static func snapshot(_ state: SurfAceLocklessAuthorityState) -> [Self] {
        state.liveSurfaces.values.sorted { $0.surfaceId < $1.surfaceId }.map { surface in
            Self(
                surfaceId: surface.surfaceId,
                panes: surface.panes.values.sorted { $0.paneId < $1.paneId }.map {
                    Pane(
                        paneId: String($0.paneId), paneLineageId: $0.paneLineageId,
                        paneLabel: $0.paneLabel, allocationGeneration: $0.allocationGeneration
                    )
                },
                windowGeneration: state.registryBinding != nil && surface.windowLabelConfirmed != false
                    ? surface.allocationGeneration : nil
            )
        }
    }
}

struct SurfAceRegistrationAssignment: Codable, Equatable, Sendable {
    let surfaceId: String
    let windowLabel: String
    let windowAllocationGeneration: Int64?
    let panes: [SurfAceRegistrationSurface.Pane]
    let windowGenerationFieldsConflict: Bool
    let windowGenerationWasMalformed: Bool
    let panesWereMissing: Bool
    let panesWereMalformed: Bool
    let discardedPaneCount: Int

    private enum CodingKeys: String, CodingKey {
        case surfaceId, windowLabel, windowAllocationGeneration, windowGeneration, panes
    }

    init(
        surfaceId: String,
        windowLabel: String,
        windowAllocationGeneration: Int64? = nil,
        panes: [SurfAceRegistrationSurface.Pane] = [],
        windowGenerationFieldsConflict: Bool = false,
        windowGenerationWasMalformed: Bool = false,
        panesWereMissing: Bool = false,
        panesWereMalformed: Bool = false,
        discardedPaneCount: Int = 0
    ) {
        self.surfaceId = surfaceId
        self.windowLabel = windowLabel
        self.windowAllocationGeneration = windowAllocationGeneration
        self.panes = panes
        self.windowGenerationFieldsConflict = windowGenerationFieldsConflict
        self.windowGenerationWasMalformed = windowGenerationWasMalformed
        self.panesWereMissing = panesWereMissing
        self.panesWereMalformed = panesWereMalformed
        self.discardedPaneCount = discardedPaneCount
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        surfaceId = try container.decode(String.self, forKey: .surfaceId)
        windowLabel = try container.decode(String.self, forKey: .windowLabel)

        let hasWindowGeneration = container.contains(.windowGeneration)
        let hasLegacyWindowGeneration = container.contains(.windowAllocationGeneration)
        var decodedWindowGeneration: Int64?
        var generationWasMalformed = false
        if hasWindowGeneration {
            do {
                decodedWindowGeneration = try container.decodeIfPresent(Int64.self, forKey: .windowGeneration)
            } catch {
                decodedWindowGeneration = nil
                generationWasMalformed = true
            }
        }
        var decodedLegacyWindowGeneration: Int64?
        if hasLegacyWindowGeneration {
            do {
                decodedLegacyWindowGeneration = try container.decodeIfPresent(
                    Int64.self, forKey: .windowAllocationGeneration
                )
            } catch {
                decodedLegacyWindowGeneration = nil
                generationWasMalformed = true
            }
        }
        if let decodedWindowGeneration, let decodedLegacyWindowGeneration,
           decodedWindowGeneration != decodedLegacyWindowGeneration {
            windowAllocationGeneration = nil
            windowGenerationFieldsConflict = true
        } else {
            windowAllocationGeneration = decodedWindowGeneration ?? decodedLegacyWindowGeneration
            windowGenerationFieldsConflict = false
        }
        windowGenerationWasMalformed = generationWasMalformed

        panesWereMissing = !container.contains(.panes)
        if container.contains(.panes) {
            do {
                let decoded = try container.decode(SurfAceLossyArray<SurfAceRegistrationSurface.Pane>.self, forKey: .panes)
                panes = decoded.values
                discardedPaneCount = decoded.discardedCount
                panesWereMalformed = false
            } catch {
                panes = []
                discardedPaneCount = 0
                panesWereMalformed = true
            }
        } else {
            panes = []
            discardedPaneCount = 0
            panesWereMalformed = false
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(surfaceId, forKey: .surfaceId)
        try container.encode(windowLabel, forKey: .windowLabel)
        // Keep the on-disk provisioned-claim spelling stable; both spellings are
        // accepted only on registry replies.
        try container.encodeIfPresent(windowAllocationGeneration, forKey: .windowAllocationGeneration)
        try container.encode(panes, forKey: .panes)
    }
}

struct SurfAcePaneReleaseRequest: Codable, Equatable, Sendable {
    let allocationGeneration: Int64
    let clientId: String
    let closeRevision: Int64
    let lineageId: String
    let paneId: String
    let paneLabel: Int64
    let surfaceId: String
    let terminalRetirementRevision: Int64
    let tombstoneId: String
    let tombstoneKind: String
    let releaseId: String
}

struct SurfAceWindowReleaseRequest: Codable, Equatable, Sendable {
    let allocationGeneration: Int64
    let clientId: String
    let closeRevision: Int64
    let surfaceId: String
    let terminalRetirementRevision: Int64
    let tombstoneId: String
    let tombstoneKind: String
    let windowLabel: String
    let releaseId: String

    var wireReleaseId: String {
        guard let kind = SurfAceLocklessTombstoneReclamation.Kind(rawValue: tombstoneKind) else {
            return releaseId
        }
        return SurfAceLocklessAllocationReleaseIdentity.window(
            allocationGeneration: allocationGeneration,
            clientId: clientId,
            closeRevision: closeRevision,
            surfaceId: surfaceId,
            terminalRetirementRevision: terminalRetirementRevision,
            tombstoneId: tombstoneId,
            tombstoneKind: kind,
            windowLabel: windowLabel
        ) ?? releaseId
    }

    private enum CodingKeys: String, CodingKey {
        case allocationGeneration = "windowGeneration"
        case clientId, closeRevision, surfaceId, terminalRetirementRevision
        case tombstoneId, tombstoneKind, windowLabel, releaseId
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(allocationGeneration, forKey: .allocationGeneration)
        try container.encode(clientId, forKey: .clientId)
        try container.encode(closeRevision, forKey: .closeRevision)
        try container.encode(surfaceId, forKey: .surfaceId)
        try container.encode(terminalRetirementRevision, forKey: .terminalRetirementRevision)
        try container.encode(tombstoneId, forKey: .tombstoneId)
        try container.encode(tombstoneKind, forKey: .tombstoneKind)
        try container.encode(windowLabel, forKey: .windowLabel)
        // Old durable intents hash the same evidence with the former field name.
        // Re-encode the unchanged evidence using the registry's canonical key.
        try container.encode(wireReleaseId, forKey: .releaseId)
    }
}

struct SurfAceRegistrationInput: Equatable, Sendable {
    let clientId: String?
    let registryIdentity: SurfAceRegistryIdentity?
    let surfaces: [SurfAceRegistrationSurface]
    let pendingPaneReleases: [SurfAcePaneReleaseRequest]
    let pendingWindowReleases: [SurfAceWindowReleaseRequest]

    init(
        clientId: String? = nil,
        registryIdentity: SurfAceRegistryIdentity? = nil,
        surfaces: [SurfAceRegistrationSurface],
        pendingPaneReleases: [SurfAcePaneReleaseRequest],
        pendingWindowReleases: [SurfAceWindowReleaseRequest]
    ) {
        self.clientId = clientId
        self.registryIdentity = registryIdentity
        self.surfaces = surfaces
        self.pendingPaneReleases = pendingPaneReleases
        self.pendingWindowReleases = pendingWindowReleases
    }

    init(state: SurfAceLocklessAuthorityState, clientId: String? = nil) throws {
        let currentClientId = clientId ?? state.registryBinding?.clientId
        let binding = state.registryBinding.flatMap { $0.clientId == currentClientId ? $0 : nil }
        let identity = binding.map { SurfAceRegistryIdentity(allocatorId: $0.allocatorId, fleetId: $0.fleetId) }
        self.clientId = currentClientId
        registryIdentity = identity
        surfaces = SurfAceRegistrationSurface.snapshot(state).map { surface in
            guard binding != nil,
                  state.liveSurfaces[surface.surfaceId]?.windowLabelConfirmed != false else {
                return SurfAceRegistrationSurface(
                    surfaceId: surface.surfaceId,
                    panes: surface.panes.map { .init(
                        paneId: $0.paneId, paneLineageId: $0.paneLineageId, paneLabel: 0
                    ) }
                )
            }
            return surface
        }
        var panes: [SurfAcePaneReleaseRequest] = []
        var windows: [SurfAceWindowReleaseRequest] = []
        for intent in (state.allocationReleaseIntents ?? []).filter({ $0.status == .pending }) {
            guard let binding,
                  SurfAceLocklessAllocationReleaseIdentity.matches(intent),
                  let allocationGeneration = intent.allocationGeneration,
                  let intentClientId = intent.clientId,
                  binding.clientId == intentClientId,
                  binding.allocatorId == intent.allocatorId,
                  binding.fleetId == intent.fleetId else {
                // Evidence from an unbound client, a former client identity, or
                // another registry remains durable but is never sent here.
                continue
            }
            switch intent.allocationKind {
            case .pane:
                guard let paneId = intent.paneId,
                      let paneLabel = intent.paneLabel,
                      let lineageId = intent.paneLineageId else {
                    throw SurfAceRegistrationError.invalidResponse
                }
                panes.append(.init(
                    allocationGeneration: allocationGeneration,
                    clientId: intentClientId,
                    closeRevision: intent.closeTopologyRevision,
                    lineageId: lineageId,
                    paneId: String(paneId),
                    paneLabel: paneLabel,
                    surfaceId: intent.surfaceId,
                    terminalRetirementRevision: intent.terminalRetirementRevision,
                    tombstoneId: intent.sourceTombstoneId,
                    tombstoneKind: intent.sourceTombstoneKind.rawValue,
                    releaseId: intent.releaseId
                ))
            case .surface:
                guard let windowLabel = intent.windowLabel,
                      intent.sourceTombstoneKind == .surface else {
                    throw SurfAceRegistrationError.invalidResponse
                }
                windows.append(.init(
                    allocationGeneration: allocationGeneration,
                    clientId: intentClientId,
                    closeRevision: intent.closeTopologyRevision,
                    surfaceId: intent.surfaceId,
                    terminalRetirementRevision: intent.terminalRetirementRevision,
                    tombstoneId: intent.sourceTombstoneId,
                    tombstoneKind: intent.sourceTombstoneKind.rawValue,
                    windowLabel: windowLabel,
                    releaseId: intent.releaseId
                ))
            }
        }
        self.pendingPaneReleases = panes
        self.pendingWindowReleases = windows
    }

    init(state: SurfAceLocklessAuthorityState) throws {
        try self.init(state: state, clientId: state.registryBinding?.clientId)
    }

    func request(
        surfaces: [SurfAceRegistrationSurface]? = nil,
        pendingPaneReleases: [SurfAcePaneReleaseRequest]? = nil,
        pendingWindowReleases: [SurfAceWindowReleaseRequest]? = nil
    ) -> Self {
        Self(
            clientId: clientId,
            registryIdentity: registryIdentity,
            surfaces: surfaces ?? self.surfaces,
            pendingPaneReleases: pendingPaneReleases ?? self.pendingPaneReleases,
            pendingWindowReleases: pendingWindowReleases ?? self.pendingWindowReleases
        )
    }

    var withoutReleases: Self {
        request(pendingPaneReleases: [], pendingWindowReleases: [])
    }
}

struct SurfAceRegistryIdentity: Codable, Equatable, Sendable {
    let allocatorId: String
    let fleetId: String

    var isValid: Bool {
        allocatorId.range(of: #"^alloc_[A-Za-z0-9._:-]{3,64}$"#, options: .regularExpression) != nil &&
        fleetId.range(of: #"^[A-Za-z0-9._:-]{1,128}$"#, options: .regularExpression) != nil
    }
}

struct SurfAceEndpointLease: Decodable, Equatable, Sendable {
    let leaseGeneration: Int64
    let registrationObservedAtMs: Int64
    let leaseExpiresAtMs: Int64

    var isValid: Bool {
        let maximumSafeInteger: Int64 = 9_007_199_254_740_991
        return leaseGeneration > 0 && leaseGeneration <= maximumSafeInteger
            && registrationObservedAtMs >= 0 && registrationObservedAtMs <= maximumSafeInteger
            && leaseExpiresAtMs > registrationObservedAtMs && leaseExpiresAtMs <= maximumSafeInteger
    }
}

struct SurfAceRegistrationProjection: Equatable, Sendable {
    let directEndpoint: String?
    let prePairDescribeV1: Bool
    let allocationGenerationV1: Bool
    let endpointLease: SurfAceEndpointLease?
    let completedPaneReleaseIds: [String]
    let completedWindowReleaseIds: [String]
    let windowGenerationV1: Bool

    init(
        directEndpoint: String?,
        prePairDescribeV1: Bool,
        allocationGenerationV1: Bool,
        endpointLease: SurfAceEndpointLease?,
        completedPaneReleaseIds: [String],
        completedWindowReleaseIds: [String],
        windowGenerationV1: Bool = false
    ) {
        self.directEndpoint = directEndpoint
        self.prePairDescribeV1 = prePairDescribeV1
        self.allocationGenerationV1 = allocationGenerationV1
        self.endpointLease = endpointLease
        self.completedPaneReleaseIds = completedPaneReleaseIds
        self.completedWindowReleaseIds = completedWindowReleaseIds
        self.windowGenerationV1 = windowGenerationV1
    }
}

struct SurfAceRegistrationReply: Equatable, Sendable {
    let assignments: [SurfAceRegistrationAssignment]
    let projection: SurfAceRegistrationProjection
    let warnings: [String]
    let registryIdentity: SurfAceRegistryIdentity?
    let discarded: Bool
    let needsRetry: Bool

    init(
        assignments: [SurfAceRegistrationAssignment],
        projection: SurfAceRegistrationProjection,
        warnings: [String] = [],
        registryIdentity: SurfAceRegistryIdentity? = nil,
        discarded: Bool = false,
        needsRetry: Bool = false
    ) {
        self.assignments = assignments
        self.projection = projection
        self.warnings = warnings
        self.registryIdentity = registryIdentity
        self.discarded = discarded
        self.needsRetry = needsRetry
    }
}

struct SurfAcePaneAllocation: Equatable, Sendable {
    let paneLabel: Int64
    let allocationGeneration: Int64?
    let warnings: [String]

    init(paneLabel: Int64, allocationGeneration: Int64?, warnings: [String] = []) {
        self.paneLabel = paneLabel
        self.allocationGeneration = allocationGeneration
        self.warnings = warnings
    }
}

struct SurfAceRegistryIdentityRead: Equatable, Sendable {
    let identity: SurfAceRegistryIdentity?
    let warnings: [String]
}

struct SurfAceRegistryBinding: Codable, Equatable, Hashable, Sendable {
    let allocatorId: String
    let clientId: String
    let fleetId: String

    func matches(_ identity: SurfAceRegistryIdentity, clientId: String) -> Bool {
        self.clientId == clientId && allocatorId == identity.allocatorId && fleetId == identity.fleetId
    }
}

struct SurfAceProvisionedRegistryBinding: Codable, Equatable, Sendable {
    let binding: SurfAceRegistryBinding
    let confirmedClaims: [SurfAceRegistrationAssignment]

    static func matchesConfirmedClaims(
        _ provisioned: [SurfAceRegistrationAssignment],
        _ local: [SurfAceRegistrationAssignment]
    ) -> Bool {
        guard !local.isEmpty, provisioned.count == local.count else { return false }
        var expected: [String: SurfAceRegistrationAssignment] = [:]
        for claim in provisioned {
            guard expected.updateValue(claim, forKey: claim.surfaceId) == nil else { return false }
        }
        var seen = Set<String>()
        for claim in local {
            guard seen.insert(claim.surfaceId).inserted,
                  let match = expected[claim.surfaceId],
                  match.windowLabel == claim.windowLabel,
                  match.windowAllocationGeneration == claim.windowAllocationGeneration,
                  match.panes.count == claim.panes.count else { return false }
            var expectedPanes: [String: SurfAceRegistrationSurface.Pane] = [:]
            for pane in match.panes {
                guard expectedPanes.updateValue(pane, forKey: pane.paneId) == nil else { return false }
            }
            var seenPanes = Set<String>()
            for pane in claim.panes {
                guard seenPanes.insert(pane.paneId).inserted,
                      expectedPanes[pane.paneId] == pane else { return false }
            }
        }
        return true
    }

    static func load(from directory: URL) throws -> Self? {
        let url = directory.appendingPathComponent("registry-binding.provisioned.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
    }

    static func confirmedClaims(_ state: SurfAceLocklessAuthorityState) -> [SurfAceRegistrationAssignment] {
        let surfaces = Array(state.liveSurfaces.values) + state.surfaceTombstones.map(\.surface)
        return surfaces.sorted { $0.surfaceId < $1.surfaceId }.compactMap { surface in
            let retained = Array(surface.panes.values) + surface.paneTombstones.map(\.pane)
            let panes = retained.filter { $0.paneLabel > 0 }.sorted { $0.paneId < $1.paneId }
                .map { SurfAceRegistrationSurface.Pane(
                    paneId: String($0.paneId), paneLineageId: $0.paneLineageId,
                    paneLabel: $0.paneLabel, allocationGeneration: $0.allocationGeneration
                ) }
            // New local letters are provisional. An absent marker is older state
            // whose window-only label must not be mistaken for a fresh client.
            guard (!surface.windowLabel.isEmpty && surface.windowLabelConfirmed != false)
                    || !panes.isEmpty else { return nil }
            return SurfAceRegistrationAssignment(
                surfaceId: surface.surfaceId, windowLabel: surface.windowLabel,
                windowAllocationGeneration: surface.allocationGeneration, panes: panes
            )
        }
    }
}

// This file is installed only after the owner has independently checked the
// allocation history and local provenance. Discovery is not that evidence.
struct SurfAceVerifiedUnconfirmedMigration: Codable, Equatable, Sendable {
    let clientId: String
    let evidenceId: String
    let allocationHistoryEvidence: String
    let localProvenanceEvidence: String
    let otherFleetCheckEvidence: String
    let localClaims: [SurfAceRegistrationAssignment]

    static func load(from directory: URL) throws -> Self? {
        let url = directory.appendingPathComponent("registry-unconfirmed.provisioned.json")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try JSONDecoder().decode(Self.self, from: Data(contentsOf: url))
    }

    func matchingSurfaceIds(in state: SurfAceLocklessAuthorityState, clientId: String) -> Set<String>? {
        guard self.clientId == clientId, !evidenceId.isEmpty,
              !allocationHistoryEvidence.isEmpty, !localProvenanceEvidence.isEmpty,
              !otherFleetCheckEvidence.isEmpty, state.registryBinding == nil,
              state.unconfirmedMigration == nil, !localClaims.isEmpty,
              localClaims == SurfAceProvisionedRegistryBinding.confirmedClaims(state),
              localClaims.allSatisfy({ !$0.windowLabel.isEmpty && $0.panes.isEmpty }) else { return nil }
        let ids = Set(localClaims.map(\.surfaceId))
        guard ids.count == localClaims.count else { return nil }
        let surfaces = Array(state.liveSurfaces.values) + state.surfaceTombstones.map(\.surface)
        guard surfaces.filter({ ids.contains($0.surfaceId) }).count == ids.count,
              surfaces.filter({ ids.contains($0.surfaceId) }).allSatisfy({
                  $0.windowLabelConfirmed == nil &&
                  $0.panes.values.allSatisfy({ $0.paneLabel <= 0 }) &&
                  $0.paneTombstones.allSatisfy({ $0.pane.paneLabel <= 0 })
              }) else { return nil }
        return ids
    }
}

struct SurfAceUnconfirmedMigrationReceipt: Codable, Equatable, Sendable {
    let clientId: String
    let evidenceId: String
    let allocationHistoryEvidence: String
    let localProvenanceEvidence: String
    let otherFleetCheckEvidence: String
    let localClaims: [SurfAceRegistrationAssignment]
}

enum SurfAceRegistrationError: Error {
    case invalidResponse
    case unmatchedResponse
    case paneClaimRejected(code: String?, message: String?)
    case serverRejected(code: String?, message: String?)
    case noServer
    case stopped
    case topologyChanged
    case registryIdentityMissing
    case foreignRegistryIdentity
    case legacyRegistryBindingPending
    case registryBindingPersistencePending
    case unconfirmedMigrationPending
}

struct SurfAceCentralRegistrationFailure: Error, LocalizedError {
    let phase: String
    let endpoint: String?
    let underlying: String

    var errorDescription: String? {
        let endpointDetail = endpoint.map { " endpoint=\($0)" } ?? ""
        return "central_registration_failed phase=\(phase)\(endpointDetail): \(underlying)"
    }
}

private func surfAceRegistrationErrorDescription(_ error: Error) -> String {
    if let registrationError = error as? SurfAceRegistrationError {
        switch registrationError {
        case .invalidResponse: return "protocol_invalid_response"
        case .unmatchedResponse: return "protocol_unmatched_reply_discarded"
        case .paneClaimRejected(let code, let message):
            return "pane_claim_rejected code=\(code ?? "missing") message=\(message ?? "missing")"
        case .serverRejected(let code, let message):
            return "server_rejected code=\(code ?? "missing") message=\(message ?? "missing")"
        case .noServer: return "no_surf_ace_server"
        case .stopped: return "registration_stopped"
        case .topologyChanged: return "registration_topology_changed"
        case .registryIdentityMissing: return "registry_identity_missing_or_invalid"
        case .foreignRegistryIdentity: return "foreign_registry_identity"
        case .legacyRegistryBindingPending: return "legacy_registry_binding_pending"
        case .registryBindingPersistencePending: return "registry_binding_persistence_pending"
        case .unconfirmedMigrationPending: return "unconfirmed_migration_pending"
        }
    }
    if let urlError = error as? URLError {
        return "\(urlError.code): \(urlError.localizedDescription)"
    }
    if let localized = error as? LocalizedError, let description = localized.errorDescription {
        return description
    }
    let value = error as NSError
    return "\(String(describing: error)) \(value.domain)(\(value.code)): \(error.localizedDescription)"
}

private func surfAceRegistrationEndpointLabel(_ url: URL) -> String {
    guard var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else {
        return "\(url.scheme ?? "ws")://\(url.host ?? "unknown")"
    }
    components.user = nil
    components.password = nil
    components.query = nil
    components.fragment = nil
    return components.string ?? "\(url.scheme ?? "ws")://\(url.host ?? "unknown")"
}

enum SurfAceRegistrationWire {
    struct ErrorPayload: Decodable {
        let code: String?
        let message: String?
    }

    struct TopologyRequest: Encodable {
        let id: String
        let op = "fleet.topology"
        let type = "request"
        let v = 1
        let sentAt = Int64(Date().timeIntervalSince1970 * 1000)
    }

    struct TopologyResponse: Decodable {
        struct Payload: Decodable { let registryIdentity: SurfAceRegistryIdentity? }
        let id: String?
        let op: String?
        let type: String?
        let v: Int?
        let ok: Bool?
        let payload: Payload?
        let payloadWasMalformed: Bool

        private enum CodingKeys: String, CodingKey { case id, op, type, v, ok, payload }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = decodeTolerantly(String.self, from: container, forKey: .id).value
            op = decodeTolerantly(String.self, from: container, forKey: .op).value
            type = decodeTolerantly(String.self, from: container, forKey: .type).value
            v = decodeTolerantly(Int.self, from: container, forKey: .v).value
            ok = decodeTolerantly(Bool.self, from: container, forKey: .ok).value
            let decodedPayload = decodeTolerantly(Payload.self, from: container, forKey: .payload)
            payload = decodedPayload.value
            payloadWasMalformed = decodedPayload.malformed
        }
    }

    static func topologyData(id: String) throws -> Data {
        try JSONEncoder().encode(TopologyRequest(id: id))
    }

    private struct CorrelationEnvelope: Decodable {
        let id: String?
        let op: String?
    }

    static func responseMatches(_ data: Data, requestId: String, operation: String) -> Bool {
        guard let envelope = try? JSONDecoder().decode(CorrelationEnvelope.self, from: data) else { return false }
        return envelope.id == requestId && envelope.op == operation
    }

    static func registryIdentityReply(
        from data: Data,
        requestId: String,
        fallbackIdentity: SurfAceRegistryIdentity? = nil,
        correlationWarnings: [String] = []
    ) -> SurfAceRegistryIdentityRead {
        var warnings = correlationWarnings
        guard let response = try? JSONDecoder().decode(TopologyResponse.self, from: data) else {
            warnings.append("topology_reply_unrecognized")
            return SurfAceRegistryIdentityRead(identity: fallbackIdentity, warnings: Array(Set(warnings)).sorted())
        }
        guard response.id == requestId, response.op == "fleet.topology" else {
            warnings.append("topology_reply_correlation_mismatch")
            return SurfAceRegistryIdentityRead(identity: fallbackIdentity, warnings: Array(Set(warnings)).sorted())
        }
        if response.type != "response" { warnings.append("topology_reply_type_unrecognized") }
        if response.v != 1 { warnings.append("topology_version_unrecognized") }
        if response.ok == false { warnings.append("topology_request_rejected") }
        if response.ok == nil { warnings.append("topology_ok_missing_or_unrecognized") }
        if response.payloadWasMalformed { warnings.append("topology_payload_unrecognized") }

        let reportedIdentity = response.payload?.registryIdentity
        if let reportedIdentity, reportedIdentity.isValid {
            return SurfAceRegistryIdentityRead(identity: reportedIdentity, warnings: Array(Set(warnings)).sorted())
        }
        warnings.append("topology_registry_identity_missing_or_unrecognized")
        return SurfAceRegistryIdentityRead(identity: fallbackIdentity, warnings: Array(Set(warnings)).sorted())
    }

    static func registryIdentity(from data: Data, requestId: String) throws -> SurfAceRegistryIdentity {
        guard let identity = registryIdentityReply(from: data, requestId: requestId).identity else {
            throw SurfAceRegistrationError.registryIdentityMissing
        }
        return identity
    }

    struct PaneClaimRequest: Encodable {
        struct Payload: Encodable {
            let clientId: String
            let surfaceId: String
            let paneId: String
            let paneLineageId: String
        }
        let id: String
        let op = "pane.claim"
        let type = "request"
        let v = 1
        let sentAt = Int64(Date().timeIntervalSince1970 * 1000)
        let payload: Payload
    }

    struct PaneClaimResponse: Decodable {
        struct Payload: Decodable {
            let paneLabel: Int64?
            let paneLabelWasMalformed: Bool
            let allocationGeneration: Int64?
            let allocationGenerationWasMalformed: Bool

            private enum CodingKeys: String, CodingKey { case paneLabel, allocationGeneration }

            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let label = decodeTolerantly(Int64.self, from: container, forKey: .paneLabel)
                paneLabel = label.value
                paneLabelWasMalformed = label.malformed
                let generation = decodeTolerantly(Int64.self, from: container, forKey: .allocationGeneration)
                allocationGeneration = generation.value
                allocationGenerationWasMalformed = generation.malformed
            }
        }
        let id: String?
        let op: String?
        let ok: Bool?
        let payload: Payload?
        let error: ErrorPayload?

        private enum CodingKeys: String, CodingKey { case id, op, ok, payload, error }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = decodeTolerantly(String.self, from: container, forKey: .id).value
            op = decodeTolerantly(String.self, from: container, forKey: .op).value
            ok = decodeTolerantly(Bool.self, from: container, forKey: .ok).value
            payload = decodeTolerantly(Payload.self, from: container, forKey: .payload).value
            error = decodeTolerantly(ErrorPayload.self, from: container, forKey: .error).value
        }
    }
    struct Payload: Codable {
        let clientId: String
        let allocationGenerationV1: Bool
        let windowGenerationV1: Bool
        let pendingPaneReleases: [SurfAcePaneReleaseRequest]
        let pendingWindowReleases: [SurfAceWindowReleaseRequest]
        let surfaces: [SurfAceRegistrationSurface]
    }

    struct Request: Encodable {
        let id: String
        let op = "client.register"
        let type = "request"
        let v = 1
        let sentAt = Int64(Date().timeIntervalSince1970 * 1000)
        let payload: Payload
    }

    struct Response: Decodable {
        struct Payload: Decodable {
            let clientId: String?
            let clientIdWasMalformed: Bool
            let registryIdentity: SurfAceRegistryIdentity?
            let registryIdentityWasMalformed: Bool
            let surfaces: [SurfAceRegistrationAssignment]
            let surfacesWereMissing: Bool
            let surfacesWereMalformed: Bool
            let discardedSurfaceCount: Int
            let directEndpoint: String?
            let directEndpointWasMalformed: Bool
            let prePairDescribeV1: Bool?
            let prePairDescribeV1WasMalformed: Bool
            let allocationGenerationV1: Bool?
            let allocationGenerationV1WasMalformed: Bool
            let windowGenerationV1: Bool?
            let windowGenerationV1WasMalformed: Bool
            let endpointLease: SurfAceEndpointLease?
            let endpointLeaseWasMalformed: Bool
            let completedPaneReleaseIds: [String]?
            let completedPaneReleaseIdsWereMalformed: Bool
            let discardedPaneReleaseIdCount: Int
            let completedWindowReleaseIds: [String]?
            let completedWindowReleaseIdsWereMalformed: Bool
            let discardedWindowReleaseIdCount: Int

            private enum CodingKeys: String, CodingKey {
                case clientId, registryIdentity, surfaces, directEndpoint, prePairDescribeV1
                case allocationGenerationV1, windowGenerationV1, endpointLease
                case completedPaneReleaseIds, completedWindowReleaseIds
            }

            init(from decoder: Decoder) throws {
                let container = try decoder.container(keyedBy: CodingKeys.self)
                let decodedClientId = decodeTolerantly(String.self, from: container, forKey: .clientId)
                clientId = decodedClientId.value
                clientIdWasMalformed = decodedClientId.malformed

                let identity = decodeTolerantly(
                    SurfAceRegistryIdentity.self, from: container, forKey: .registryIdentity
                )
                registryIdentity = identity.value
                registryIdentityWasMalformed = identity.malformed

                surfacesWereMissing = !container.contains(.surfaces)
                if container.contains(.surfaces) {
                    do {
                        let decoded = try container.decode(
                            SurfAceLossyArray<SurfAceRegistrationAssignment>.self, forKey: .surfaces
                        )
                        surfaces = decoded.values
                        discardedSurfaceCount = decoded.discardedCount
                        surfacesWereMalformed = false
                    } catch {
                        surfaces = []
                        discardedSurfaceCount = 0
                        surfacesWereMalformed = true
                    }
                } else {
                    surfaces = []
                    discardedSurfaceCount = 0
                    surfacesWereMalformed = false
                }

                let endpoint = decodeTolerantly(String.self, from: container, forKey: .directEndpoint)
                directEndpoint = endpoint.value
                directEndpointWasMalformed = endpoint.malformed
                let prePair = decodeTolerantly(Bool.self, from: container, forKey: .prePairDescribeV1)
                prePairDescribeV1 = prePair.value
                prePairDescribeV1WasMalformed = prePair.malformed
                let allocation = decodeTolerantly(Bool.self, from: container, forKey: .allocationGenerationV1)
                allocationGenerationV1 = allocation.value
                allocationGenerationV1WasMalformed = allocation.malformed
                let window = decodeTolerantly(Bool.self, from: container, forKey: .windowGenerationV1)
                windowGenerationV1 = window.value
                windowGenerationV1WasMalformed = window.malformed
                let lease = decodeTolerantly(SurfAceEndpointLease.self, from: container, forKey: .endpointLease)
                endpointLease = lease.value
                endpointLeaseWasMalformed = lease.malformed

                let paneReleases = decodeTolerantly(
                    SurfAceLossyArray<String>.self, from: container, forKey: .completedPaneReleaseIds
                )
                completedPaneReleaseIds = paneReleases.value?.values
                discardedPaneReleaseIdCount = paneReleases.value?.discardedCount ?? 0
                completedPaneReleaseIdsWereMalformed = paneReleases.malformed
                let windowReleases = decodeTolerantly(
                    SurfAceLossyArray<String>.self, from: container, forKey: .completedWindowReleaseIds
                )
                completedWindowReleaseIds = windowReleases.value?.values
                discardedWindowReleaseIdCount = windowReleases.value?.discardedCount ?? 0
                completedWindowReleaseIdsWereMalformed = windowReleases.malformed
            }
        }
        let id: String?
        let op: String?
        let type: String?
        let version: Int?
        let ok: Bool?
        let payload: Payload?
        let error: ErrorPayload?
        let payloadWasMalformed: Bool
        let errorWasMalformed: Bool

        private enum CodingKeys: String, CodingKey { case id, op, type, v, ok, payload, error }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            id = decodeTolerantly(String.self, from: container, forKey: .id).value
            op = decodeTolerantly(String.self, from: container, forKey: .op).value
            type = decodeTolerantly(String.self, from: container, forKey: .type).value
            version = decodeTolerantly(Int.self, from: container, forKey: .v).value
            ok = decodeTolerantly(Bool.self, from: container, forKey: .ok).value
            let decodedPayload = decodeTolerantly(Payload.self, from: container, forKey: .payload)
            payload = decodedPayload.value
            payloadWasMalformed = decodedPayload.malformed
            let decodedError = decodeTolerantly(ErrorPayload.self, from: container, forKey: .error)
            error = decodedError.value
            errorWasMalformed = decodedError.malformed
        }
    }

    static func requestData(clientId: String, surfaces: [SurfAceRegistrationSurface], id: String) throws -> Data {
        try JSONEncoder().encode(Request(id: id, payload: Payload(
            clientId: clientId, allocationGenerationV1: false, windowGenerationV1: false,
            pendingPaneReleases: [], pendingWindowReleases: [], surfaces: surfaces
        )))
    }

    static func requestData(clientId: String, input: SurfAceRegistrationInput, id: String) throws -> Data {
        try JSONEncoder().encode(Request(id: id, payload: Payload(
            clientId: clientId, allocationGenerationV1: true, windowGenerationV1: true,
            pendingPaneReleases: input.pendingPaneReleases,
            pendingWindowReleases: input.pendingWindowReleases,
            surfaces: input.surfaces
        )))
    }

    static func paneClaimData(clientId: String, surfaceId: String, paneId: Int64,
                              paneLineageId: String, id: String) throws -> Data {
        try JSONEncoder().encode(PaneClaimRequest(
            id: id, payload: .init(clientId: clientId, surfaceId: surfaceId,
                                  paneId: String(paneId), paneLineageId: paneLineageId)
        ))
    }

    static func paneClaimAllocation(
        from data: Data,
        requestId: String,
        expectedAllocationGenerationV1: Bool,
        correlationWarnings: [String] = []
    ) throws -> SurfAcePaneAllocation {
        guard let response = try? JSONDecoder().decode(PaneClaimResponse.self, from: data) else {
            return SurfAcePaneAllocation(
                paneLabel: 0, allocationGeneration: nil,
                warnings: correlationWarnings + ["pane_claim_reply_unrecognized"]
            )
        }
        guard response.id == requestId, response.op == "pane.claim" else {
            return SurfAcePaneAllocation(
                paneLabel: 0, allocationGeneration: nil,
                warnings: correlationWarnings + ["pane_claim_correlation_mismatch"]
            )
        }
        var warnings = correlationWarnings
        if response.ok == false {
            warnings.append("pane_claim_refused code=\(response.error?.code ?? "missing")")
            return SurfAcePaneAllocation(paneLabel: 0, allocationGeneration: nil, warnings: warnings)
        }
        if response.ok == nil { warnings.append("pane_claim_ok_missing_or_unrecognized") }
        guard let payload = response.payload, let paneLabel = payload.paneLabel, paneLabel > 0 else {
            warnings.append("pane_claim_label_missing_or_unrecognized")
            return SurfAcePaneAllocation(paneLabel: 0, allocationGeneration: nil, warnings: warnings)
        }
        let maximumSafeInteger: Int64 = 9_007_199_254_740_991
        let generation = payload.allocationGeneration.flatMap { $0 > 0 && $0 <= maximumSafeInteger ? $0 : nil }
        if payload.paneLabelWasMalformed { warnings.append("pane_claim_label_unrecognized") }
        if payload.allocationGenerationWasMalformed || (payload.allocationGeneration != nil && generation == nil) {
            warnings.append("pane_claim_generation_unrecognized")
        } else if expectedAllocationGenerationV1 && generation == nil {
            warnings.append("pane_claim_generation_missing")
        } else if !expectedAllocationGenerationV1 && generation != nil {
            warnings.append("pane_claim_generation_returned_without_negotiation")
        }
        return SurfAcePaneAllocation(
            paneLabel: paneLabel,
            allocationGeneration: generation,
            warnings: warnings
        )
    }

    static func paneClaimLabel(from data: Data, requestId: String) throws -> Int64 {
        try paneClaimAllocation(
            from: data, requestId: requestId, expectedAllocationGenerationV1: false
        ).paneLabel
    }

    static func assignments(
        from data: Data,
        requestId: String,
        clientId: String,
        surfaces: [SurfAceRegistrationSurface],
        expectedIdentity: SurfAceRegistryIdentity
    ) throws -> [SurfAceRegistrationAssignment] {
        let reply = try registration(
            from: data,
            requestId: requestId,
            clientId: clientId,
            surfaces: surfaces,
            expectedIdentity: expectedIdentity
        )
        guard !reply.discarded, reply.registryIdentity == expectedIdentity else { return [] }
        return reply.assignments
    }

    static func registration(
        from data: Data,
        requestId: String,
        clientId: String,
        surfaces: [SurfAceRegistrationSurface],
        expectedIdentity: SurfAceRegistryIdentity?,
        expectedDirectEndpoint: String? = nil,
        expectedPrePairDescribeV1: Bool = false,
        expectedAllocationGenerationV1: Bool = false,
        expectedWindowGenerationV1: Bool = false,
        expectedPaneReleaseIds: [String] = [],
        expectedWindowReleaseIds: [String] = [],
        correlationWarnings: [String] = []
    ) throws -> SurfAceRegistrationReply {
        guard let response = try? JSONDecoder().decode(Response.self, from: data) else {
            return SurfAceRegistrationReply(
                assignments: [], projection: emptyProjection,
                warnings: correlationWarnings + ["registration_reply_unrecognized"],
                registryIdentity: expectedIdentity, discarded: true, needsRetry: true
            )
        }
        guard response.id == requestId, response.op == "client.register" else {
            return SurfAceRegistrationReply(
                assignments: [], projection: emptyProjection,
                warnings: correlationWarnings + ["registration_reply_correlation_mismatch"],
                registryIdentity: expectedIdentity, discarded: true, needsRetry: true
            )
        }
        var warnings = correlationWarnings
        if response.type != "response" { warnings.append("registration_reply_type_unrecognized") }
        if response.version != 1 { warnings.append("registration_version_unrecognized") }
        if response.payloadWasMalformed { warnings.append("registration_payload_unrecognized") }
        if response.errorWasMalformed { warnings.append("registration_error_unrecognized") }
        if response.ok == nil { warnings.append("registration_ok_missing_or_unrecognized") }
        guard let payload = response.payload else {
            if response.ok == false {
                throw SurfAceRegistrationError.serverRejected(
                    code: response.error?.code, message: response.error?.message
                )
            }
            warnings.append("registration_payload_missing")
            return SurfAceRegistrationReply(
                assignments: [], projection: emptyProjection,
                warnings: Array(Set(warnings)).sorted(), registryIdentity: expectedIdentity,
                needsRetry: true
            )
        }

        let identity: SurfAceRegistryIdentity?
        if let reportedIdentity = payload.registryIdentity, reportedIdentity.isValid {
            identity = reportedIdentity
        } else {
            identity = expectedIdentity
            warnings.append("registration_registry_identity_missing_or_unrecognized")
        }
        if let identity, let expectedIdentity, identity != expectedIdentity {
            warnings.append("registration_registry_identity_changed")
        }
        if payload.clientIdWasMalformed || payload.clientId == nil {
            warnings.append("registration_client_identity_missing_or_unrecognized")
        } else if payload.clientId != clientId {
            warnings.append("registration_client_identity_mismatch")
            return SurfAceRegistrationReply(
                assignments: [], projection: emptyProjection,
                warnings: Array(Set(warnings)).sorted(), registryIdentity: identity,
                discarded: true, needsRetry: true
            )
        }
        // An explicit negative from a newly identified registry first replaces
        // stale local claims; the retry then uses the registry's actual identity.
        if response.ok == false, identity != expectedIdentity {
            return SurfAceRegistrationReply(
                assignments: [], projection: emptyProjection,
                warnings: Array(Set(warnings)).sorted(), registryIdentity: identity,
                discarded: true, needsRetry: true
            )
        }
        // Matching-identity negative results use the existing per-claim and
        // release recovery path.
        if response.ok == false {
            throw SurfAceRegistrationError.serverRejected(
                code: response.error?.code,
                message: response.error?.message
            )
        }
        var needsRetry = expectedIdentity == nil && identity == nil
        if payload.registryIdentityWasMalformed {
            warnings.append("registration_identity_shape_unrecognized")
        }
        if payload.surfacesWereMissing { warnings.append("registration_surface_claims_missing") }
        if payload.surfacesWereMalformed { warnings.append("registration_surface_claims_unrecognized") }
        if payload.discardedSurfaceCount > 0 {
            warnings.append("registration_surface_claims_dropped count=\(payload.discardedSurfaceCount)")
        }
        let expectedSurfaceIds = Set(surfaces.map(\.surfaceId))
        let returnedSurfaceIds = payload.surfaces.map(\.surfaceId)
        if returnedSurfaceIds.count != surfaces.count || Set(returnedSurfaceIds) != expectedSurfaceIds {
            warnings.append("registration_surface_claim_set_incomplete")
            needsRetry = needsRetry || !surfaces.isEmpty
        }
        if let allocationFlag = payload.allocationGenerationV1,
           allocationFlag != expectedAllocationGenerationV1 {
            warnings.append("registration_pane_generation_capability_mismatch")
        } else if payload.allocationGenerationV1 == nil && expectedAllocationGenerationV1 {
            warnings.append("registration_pane_generation_capability_missing")
        }
        if payload.allocationGenerationV1WasMalformed {
            warnings.append("registration_pane_generation_capability_unrecognized")
        }
        if let windowFlag = payload.windowGenerationV1, windowFlag != expectedWindowGenerationV1 {
            warnings.append("registration_window_generation_capability_mismatch")
        } else if payload.windowGenerationV1 == nil && expectedWindowGenerationV1 {
            warnings.append("registration_window_generation_capability_missing")
        }
        if payload.windowGenerationV1WasMalformed {
            warnings.append("registration_window_generation_capability_unrecognized")
        }

        for assignment in payload.surfaces {
            if assignment.windowGenerationFieldsConflict {
                warnings.append("registration_window_generation_fields_conflict surface=\(assignment.surfaceId)")
            }
            let windowGeneration = assignment.windowAllocationGeneration
            if assignment.windowGenerationWasMalformed || (windowGeneration != nil && !isValidGeneration(windowGeneration)) {
                warnings.append("registration_window_generation_unrecognized surface=\(assignment.surfaceId)")
            } else if expectedWindowGenerationV1 && windowGeneration == nil {
                warnings.append("registration_window_generation_missing surface=\(assignment.surfaceId)")
            }
            if assignment.panesWereMissing || assignment.panesWereMalformed {
                warnings.append("registration_pane_claims_unavailable surface=\(assignment.surfaceId)")
            }
            if assignment.discardedPaneCount > 0 {
                warnings.append("registration_pane_claims_dropped surface=\(assignment.surfaceId) count=\(assignment.discardedPaneCount)")
            }
            for pane in assignment.panes {
                if pane.allocationGenerationWasMalformed
                    || (pane.allocationGeneration != nil && !isValidGeneration(pane.allocationGeneration)) {
                    warnings.append("registration_pane_generation_unrecognized surface=\(assignment.surfaceId) pane=\(pane.paneId)")
                } else if expectedAllocationGenerationV1 && pane.allocationGeneration == nil {
                    warnings.append("registration_pane_generation_missing surface=\(assignment.surfaceId) pane=\(pane.paneId)")
                }
            }
            if let expectedSurface = surfaces.first(where: { $0.surfaceId == assignment.surfaceId }) {
                let expectedPaneIds = Set(expectedSurface.panes.map(\.paneId))
                let returnedPaneIds = assignment.panes.map(\.paneId)
                if returnedPaneIds.count != expectedSurface.panes.count
                    || Set(returnedPaneIds) != expectedPaneIds {
                    needsRetry = true
                }
            }
        }

        let directEndpoint = payload.directEndpoint
        let prePairDescribeV1 = payload.prePairDescribeV1 ?? false
        let allocationGenerationV1 = payload.allocationGenerationV1 ?? false
        let endpointLease = payload.endpointLease
        if payload.directEndpointWasMalformed { warnings.append("registration_endpoint_unrecognized") }
        if payload.prePairDescribeV1WasMalformed { warnings.append("registration_pre_pair_capability_unrecognized") }
        if payload.endpointLeaseWasMalformed { warnings.append("registration_endpoint_lease_unrecognized") }
        if directEndpoint != expectedDirectEndpoint || prePairDescribeV1 != expectedPrePairDescribeV1 {
            warnings.append("registration_endpoint_capability_mismatch")
        }
        if (endpointLease != nil) != (expectedDirectEndpoint != nil && expectedPrePairDescribeV1) {
            warnings.append("registration_endpoint_lease_missing_or_unexpected")
        }
        if expectedDirectEndpoint.map(isSupportedDirectEndpoint) == false {
            warnings.append("registration_expected_endpoint_unrecognized")
        }
        if let directEndpoint, !isSupportedDirectEndpoint(directEndpoint) {
            warnings.append("registration_endpoint_unrecognized")
        }
        if let endpointLease, !endpointLease.isValid { warnings.append("registration_endpoint_lease_invalid") }
        let endpointMatchesRequest = directEndpoint == expectedDirectEndpoint
            && prePairDescribeV1 == expectedPrePairDescribeV1
            && (expectedDirectEndpoint.map(isSupportedDirectEndpoint) ?? true)
            && (endpointLease.map(\.isValid) ?? true)
            && ((endpointLease != nil) == (expectedDirectEndpoint != nil && expectedPrePairDescribeV1))
        let usableEndpoint = endpointMatchesRequest ? directEndpoint : nil
        let usablePrePairDescribe = endpointMatchesRequest ? prePairDescribeV1 : false
        let usableEndpointLease = endpointMatchesRequest ? endpointLease : nil

        func acceptedReleaseIds(_ received: [String]?, expected: [String]?, malformed: Bool, name: String) -> [String] {
            let expectedIds = expected ?? []
            let receivedIds = received ?? []
            let receivedSet = Set(receivedIds)
            if expectedIds.isEmpty, received == nil, !malformed { return [] }
            if malformed || received == nil || receivedIds.count != expectedIds.count
                || receivedSet.count != receivedIds.count || receivedSet != Set(expectedIds) {
                warnings.append("registration_\(name)_acknowledgements_incomplete")
                if !expectedIds.isEmpty { needsRetry = true }
            }
            let expectedSet = Set(expectedIds)
            if receivedIds.contains(where: { !expectedSet.contains($0) }) {
                warnings.append("registration_\(name)_acknowledgements_unrecognized")
            }
            return expectedIds.filter(receivedSet.contains)
        }

        let completedPaneReleaseIds = acceptedReleaseIds(
            payload.completedPaneReleaseIds, expected: expectedPaneReleaseIds,
            malformed: payload.completedPaneReleaseIdsWereMalformed || payload.discardedPaneReleaseIdCount > 0,
            name: "pane_release"
        )
        let completedWindowReleaseIds = acceptedReleaseIds(
            payload.completedWindowReleaseIds, expected: expectedWindowReleaseIds,
            malformed: payload.completedWindowReleaseIdsWereMalformed || payload.discardedWindowReleaseIdCount > 0,
            name: "window_release"
        )

        return SurfAceRegistrationReply(
            assignments: payload.surfaces,
            projection: SurfAceRegistrationProjection(
                directEndpoint: usableEndpoint,
                prePairDescribeV1: usablePrePairDescribe,
                allocationGenerationV1: allocationGenerationV1,
                endpointLease: usableEndpointLease,
                completedPaneReleaseIds: completedPaneReleaseIds,
                completedWindowReleaseIds: completedWindowReleaseIds,
                windowGenerationV1: payload.windowGenerationV1 ?? false
            ),
            warnings: Array(Set(warnings)).sorted(),
            registryIdentity: identity,
            needsRetry: needsRetry
        )
    }

    private static var emptyProjection: SurfAceRegistrationProjection {
        SurfAceRegistrationProjection(
            directEndpoint: nil, prePairDescribeV1: false, allocationGenerationV1: false,
            endpointLease: nil, completedPaneReleaseIds: [], completedWindowReleaseIds: []
        )
    }

    private static func isValidGeneration(_ generation: Int64?) -> Bool {
        guard let generation else { return false }
        return generation > 0 && generation <= 9_007_199_254_740_991
    }

    private static func isSupportedDirectEndpoint(_ value: String) -> Bool {
        guard value.utf8.count <= 2_048,
              let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              components.host?.isEmpty == false,
              components.user == nil,
              components.password == nil,
              components.fragment == nil else { return false }
        return true
    }
}

enum SurfAceRegistrationEndpoint {
    /// A local-use numeric endpoint selects the Network.framework WebSocket transport so ATS
    /// remains narrow. Route selection still follows the configured-first/Bonjour fallback
    /// contract; remote numeric endpoints stay on URLSession.
    static func usesLocalNumericTransport(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "ws", let host = url.host else { return false }
        return isLocalNumericAddress(host)
    }

    static func isLocalNumericAddress(_ host: String) -> Bool {
        let unscopedHost = host.split(separator: "%", maxSplits: 1, omittingEmptySubsequences: true).first.map(String.init) ?? host
        var ipv4 = in_addr()
        if unscopedHost.withCString({ inet_pton(AF_INET, $0, &ipv4) }) == 1 {
            let value = UInt32(bigEndian: ipv4.s_addr)
            let privateRange = (value & 0xff000000) == 0x0a000000
                || (value & 0xffc00000) == 0x64400000
                || (value & 0xff000000) == 0x7f000000
                || (value & 0xffff0000) == 0xa9fe0000
                || (value & 0xfff00000) == 0xac100000
                || (value & 0xffff0000) == 0xc0a80000
            return privateRange
        }

        var ipv6 = in6_addr()
        guard unscopedHost.withCString({ inet_pton(AF_INET6, $0, &ipv6) }) == 1 else { return false }
        let bytes = withUnsafeBytes(of: ipv6) { Array($0) }
        let loopback = bytes.dropLast().allSatisfy { $0 == 0 } && bytes.last == 1
        let uniqueLocal = (bytes[0] & 0xfe) == 0xfc
        let linkLocal = bytes[0] == 0xfe && (bytes[1] & 0xc0) == 0x80
        return loopback || uniqueLocal || linkLocal
    }
}

@MainActor
protocol SurfAceRegistrationTransport: AnyObject {
    func readRegistryIdentity() async throws -> SurfAceRegistryIdentity
    func readRegistryIdentity(fallbackIdentity: SurfAceRegistryIdentity?) async throws -> SurfAceRegistryIdentityRead
    func register(clientId: String, surfaces: [SurfAceRegistrationSurface],
                  expectedIdentity: SurfAceRegistryIdentity) async throws -> [SurfAceRegistrationAssignment]
    func register(clientId: String, input: SurfAceRegistrationInput,
                  expectedIdentity: SurfAceRegistryIdentity) async throws -> SurfAceRegistrationReply
    func register(clientId: String, input: SurfAceRegistrationInput,
                  expectedIdentity: SurfAceRegistryIdentity?) async throws -> SurfAceRegistrationReply
    func claimPaneLabel(clientId: String, surfaceId: String, paneId: Int64,
                        paneLineageId: String) async throws -> SurfAcePaneAllocation
    func close()
}

extension SurfAceRegistrationTransport {
    func readRegistryIdentity(fallbackIdentity: SurfAceRegistryIdentity?) async throws -> SurfAceRegistryIdentityRead {
        SurfAceRegistryIdentityRead(identity: try await readRegistryIdentity(), warnings: [])
    }

    func register(clientId: String, input: SurfAceRegistrationInput,
                  expectedIdentity: SurfAceRegistryIdentity?) async throws -> SurfAceRegistrationReply {
        guard let expectedIdentity else {
            return SurfAceRegistrationReply(
                assignments: [],
                projection: SurfAceRegistrationProjection(
                    directEndpoint: nil, prePairDescribeV1: false, allocationGenerationV1: false,
                    endpointLease: nil, completedPaneReleaseIds: [], completedWindowReleaseIds: []
                ),
                warnings: ["registration_registry_identity_unavailable"], needsRetry: true
            )
        }
        return try await register(clientId: clientId, input: input, expectedIdentity: expectedIdentity)
    }

    func register(clientId: String, input: SurfAceRegistrationInput,
                  expectedIdentity: SurfAceRegistryIdentity) async throws -> SurfAceRegistrationReply {
        guard input.pendingPaneReleases.isEmpty, input.pendingWindowReleases.isEmpty else {
            throw SurfAceRegistrationError.invalidResponse
        }
        return SurfAceRegistrationReply(
            assignments: try await register(
                clientId: clientId, surfaces: input.surfaces, expectedIdentity: expectedIdentity
            ),
            projection: SurfAceRegistrationProjection(
                directEndpoint: nil, prePairDescribeV1: false,
                allocationGenerationV1: false, endpointLease: nil,
                completedPaneReleaseIds: [], completedWindowReleaseIds: []
            )
        )
    }

    func claimPaneLabel(clientId: String, surfaceId: String, paneId: Int64,
                        paneLineageId: String) async throws -> SurfAcePaneAllocation {
        throw SurfAceRegistrationError.noServer
    }
}

@MainActor
private func surfAceReceiveCorrelated(
    operation: String,
    requestId: String,
    receive: () async throws -> Data
) async throws -> (data: Data, warnings: [String]) {
    var warnings: [String] = []
    var lastUnmatched: Data?
    do {
        while true {
            let data = try await receive()
            guard !SurfAceRegistrationWire.responseMatches(data, requestId: requestId, operation: operation) else {
                return (data, warnings)
            }
            lastUnmatched = data
            warnings.append("registration_unmatched_reply_dropped operation=\(operation)")
        }
    } catch {
        if let lastUnmatched { return (lastUnmatched, warnings) }
        throw error
    }
}

@MainActor
final class SurfAceRegistrationWebSocket: SurfAceRegistrationTransport {
    private let socket: URLSessionWebSocketTask
    private let session: URLSession

    init(url: URL) {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 2
        session = URLSession(configuration: configuration)
        socket = session.webSocketTask(with: url)
        socket.resume()
    }

    func readRegistryIdentity() async throws -> SurfAceRegistryIdentity {
        guard let identity = try await readRegistryIdentity(fallbackIdentity: nil).identity else {
            throw SurfAceRegistrationError.registryIdentityMissing
        }
        return identity
    }

    func readRegistryIdentity(fallbackIdentity: SurfAceRegistryIdentity?) async throws -> SurfAceRegistryIdentityRead {
        let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let timeout = Task { [socket] in
            do {
                try await Task.sleep(for: .seconds(2))
                socket.cancel(with: .goingAway, reason: nil)
            } catch { }
        }
        defer { timeout.cancel() }
        try await socket.send(.data(SurfAceRegistrationWire.topologyData(id: id)))
        let received = try await surfAceReceiveCorrelated(operation: "fleet.topology", requestId: id) {
            let message = try await socket.receive()
            switch message {
            case .data(let value): return value
            case .string(let value): return Data(value.utf8)
            @unknown default: throw SurfAceRegistrationError.invalidResponse
            }
        }
        return SurfAceRegistrationWire.registryIdentityReply(
            from: received.data, requestId: id, fallbackIdentity: fallbackIdentity,
            correlationWarnings: received.warnings
        )
    }

    func register(clientId: String, surfaces: [SurfAceRegistrationSurface],
                  expectedIdentity: SurfAceRegistryIdentity) async throws -> [SurfAceRegistrationAssignment] {
        let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let timeout = Task { [socket] in
            do {
                try await Task.sleep(for: .seconds(2))
                socket.cancel(with: .goingAway, reason: nil)
            } catch { }
        }
        defer { timeout.cancel() }
        try await socket.send(.data(SurfAceRegistrationWire.requestData(clientId: clientId, surfaces: surfaces, id: id)))
        let received = try await surfAceReceiveCorrelated(operation: "client.register", requestId: id) {
            let message = try await socket.receive()
            switch message {
            case .data(let value): return value
            case .string(let value): return Data(value.utf8)
            @unknown default: throw SurfAceRegistrationError.invalidResponse
            }
        }
        return try SurfAceRegistrationWire.assignments(from: received.data, requestId: id, clientId: clientId,
                                                        surfaces: surfaces, expectedIdentity: expectedIdentity)
    }

    func register(clientId: String, input: SurfAceRegistrationInput,
                  expectedIdentity: SurfAceRegistryIdentity) async throws -> SurfAceRegistrationReply {
        try await register(clientId: clientId, input: input, expectedIdentity: Optional(expectedIdentity))
    }

    func register(clientId: String, input: SurfAceRegistrationInput,
                  expectedIdentity: SurfAceRegistryIdentity?) async throws -> SurfAceRegistrationReply {
        let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let timeout = Task { [socket] in
            do {
                try await Task.sleep(for: .seconds(2))
                socket.cancel(with: .goingAway, reason: nil)
            } catch { }
        }
        defer { timeout.cancel() }
        try await socket.send(.data(SurfAceRegistrationWire.requestData(clientId: clientId, input: input, id: id)))
        let received = try await surfAceReceiveCorrelated(operation: "client.register", requestId: id) {
            let message = try await socket.receive()
            switch message {
            case .data(let value): return value
            case .string(let value): return Data(value.utf8)
            @unknown default: throw SurfAceRegistrationError.invalidResponse
            }
        }
        return try SurfAceRegistrationWire.registration(
            from: received.data, requestId: id, clientId: clientId, surfaces: input.surfaces,
            expectedIdentity: expectedIdentity, expectedAllocationGenerationV1: true,
            expectedWindowGenerationV1: true,
            expectedPaneReleaseIds: input.pendingPaneReleases.map(\.releaseId),
            expectedWindowReleaseIds: input.pendingWindowReleases.map(\.wireReleaseId),
            correlationWarnings: received.warnings
        )
    }

    func claimPaneLabel(clientId: String, surfaceId: String, paneId: Int64,
                        paneLineageId: String) async throws -> SurfAcePaneAllocation {
        let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let timeout = Task { [socket] in
            do {
                try await Task.sleep(for: .seconds(2))
                socket.cancel(with: .goingAway, reason: nil)
            } catch { }
        }
        defer { timeout.cancel() }
        try await socket.send(.data(SurfAceRegistrationWire.paneClaimData(
            clientId: clientId, surfaceId: surfaceId, paneId: paneId,
            paneLineageId: paneLineageId, id: id
        )))
        let received = try await surfAceReceiveCorrelated(operation: "pane.claim", requestId: id) {
            let message = try await socket.receive()
            switch message {
            case .data(let value): return value
            case .string(let value): return Data(value.utf8)
            @unknown default: throw SurfAceRegistrationError.invalidResponse
            }
        }
        return try SurfAceRegistrationWire.paneClaimAllocation(
            from: received.data, requestId: id, expectedAllocationGenerationV1: true,
            correlationWarnings: received.warnings
        )
    }

    func close() {
        socket.cancel(with: .normalClosure, reason: nil)
        session.invalidateAndCancel()
    }
}

private final class SurfAceRegistrationContinuation<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Value, Error>?

    init(_ continuation: CheckedContinuation<Value, Error>) {
        self.continuation = continuation
    }

    func resume(returning value: Value) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(returning: value)
    }

    func resume(throwing error: Error) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        lock.unlock()
        continuation?.resume(throwing: error)
    }
}

@MainActor
final class SurfAceLocalNumericRegistrationWebSocket: SurfAceRegistrationTransport {
    private let url: URL
    private let queue = DispatchQueue(label: "co.clicketyclacks.surface.local-registration")
    private var connection: NWConnection?
    private var ready = false

    init(url: URL) {
        self.url = url
    }

    func exchange(_ data: Data) async throws -> Data {
        let timeout = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(5))
            if !Task.isCancelled { self?.close() }
        }
        defer { timeout.cancel() }
        do {
            try await connectIfNeeded()
            try await send(data)
            return try await receive()
        } catch {
            close()
            throw error
        }
    }

    func readRegistryIdentity() async throws -> SurfAceRegistryIdentity {
        guard let identity = try await readRegistryIdentity(fallbackIdentity: nil).identity else {
            throw SurfAceRegistrationError.registryIdentityMissing
        }
        return identity
    }

    func readRegistryIdentity(fallbackIdentity: SurfAceRegistryIdentity?) async throws -> SurfAceRegistryIdentityRead {
        let timeout = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .seconds(2))
                self?.connection?.cancel()
            } catch { }
        }
        defer { timeout.cancel() }
        do {
            try await connectIfNeeded()
            let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
            try await send(SurfAceRegistrationWire.topologyData(id: id))
            let received = try await surfAceReceiveCorrelated(operation: "fleet.topology", requestId: id) {
                try await self.receive()
            }
            return SurfAceRegistrationWire.registryIdentityReply(
                from: received.data, requestId: id, fallbackIdentity: fallbackIdentity,
                correlationWarnings: received.warnings
            )
        } catch {
            close()
            throw error
        }
    }

    func register(clientId: String, surfaces: [SurfAceRegistrationSurface],
                  expectedIdentity: SurfAceRegistryIdentity) async throws -> [SurfAceRegistrationAssignment] {
        let timeout = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .seconds(2))
                self?.connection?.cancel()
            } catch { }
        }
        defer { timeout.cancel() }

        do {
            try await connectIfNeeded()
            let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
            let data = try SurfAceRegistrationWire.requestData(clientId: clientId, surfaces: surfaces, id: id)
            try await send(data)
            let received = try await surfAceReceiveCorrelated(operation: "client.register", requestId: id) {
                try await self.receive()
            }
            return try SurfAceRegistrationWire.assignments(from: received.data, requestId: id, clientId: clientId,
                                                            surfaces: surfaces, expectedIdentity: expectedIdentity)
        } catch {
            close()
            throw error
        }
    }

    func register(clientId: String, input: SurfAceRegistrationInput,
                  expectedIdentity: SurfAceRegistryIdentity) async throws -> SurfAceRegistrationReply {
        try await register(clientId: clientId, input: input, expectedIdentity: Optional(expectedIdentity))
    }

    func register(clientId: String, input: SurfAceRegistrationInput,
                  expectedIdentity: SurfAceRegistryIdentity?) async throws -> SurfAceRegistrationReply {
        let timeout = Task { @MainActor [weak self] in
            do {
                try await Task.sleep(for: .seconds(2))
                self?.connection?.cancel()
            } catch { }
        }
        defer { timeout.cancel() }

        do {
            try await connectIfNeeded()
            let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
            let data = try SurfAceRegistrationWire.requestData(clientId: clientId, input: input, id: id)
            try await send(data)
            let received = try await surfAceReceiveCorrelated(operation: "client.register", requestId: id) {
                try await self.receive()
            }
            return try SurfAceRegistrationWire.registration(
                from: received.data, requestId: id, clientId: clientId,
                surfaces: input.surfaces, expectedIdentity: expectedIdentity,
                expectedAllocationGenerationV1: true, expectedWindowGenerationV1: true,
                expectedPaneReleaseIds: input.pendingPaneReleases.map(\.releaseId),
                expectedWindowReleaseIds: input.pendingWindowReleases.map(\.wireReleaseId),
                correlationWarnings: received.warnings
            )
        } catch {
            close()
            throw error
        }
    }

    func claimPaneLabel(clientId: String, surfaceId: String, paneId: Int64,
                        paneLineageId: String) async throws -> SurfAcePaneAllocation {
        do {
            try await connectIfNeeded()
            let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
            try await send(SurfAceRegistrationWire.paneClaimData(
                clientId: clientId, surfaceId: surfaceId, paneId: paneId,
                paneLineageId: paneLineageId, id: id
            ))
            let received = try await surfAceReceiveCorrelated(operation: "pane.claim", requestId: id) {
                try await self.receive()
            }
            return try SurfAceRegistrationWire.paneClaimAllocation(
                from: received.data, requestId: id, expectedAllocationGenerationV1: true,
                correlationWarnings: received.warnings
            )
        } catch {
            close()
            throw error
        }
    }

    func close() {
        connection?.cancel()
        connection = nil
        ready = false
    }

    private func connectIfNeeded() async throws {
        if ready, connection != nil { return }
        guard SurfAceRegistrationEndpoint.usesLocalNumericTransport(url), url.port != nil else {
            throw SurfAceRegistrationError.invalidResponse
        }
        let parameters = NWParameters.tcp
        let webSocket = NWProtocolWebSocket.Options()
        webSocket.autoReplyPing = true
        parameters.defaultProtocolStack.applicationProtocols.insert(webSocket, at: 0)
        let connection = NWConnection(to: .url(url), using: parameters)
        self.connection = connection
        do {
            try await waitUntilReady(connection)
            ready = true
        } catch {
            connection.cancel()
            self.connection = nil
            throw error
        }
    }

    private func waitUntilReady(_ connection: NWConnection) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            let gate = SurfAceRegistrationContinuation(continuation)
            connection.stateUpdateHandler = { [weak connection] state in
                switch state {
                case .ready:
                    connection?.stateUpdateHandler = nil
                    gate.resume(returning: ())
                case .failed, .cancelled:
                    connection?.stateUpdateHandler = nil
                    gate.resume(throwing: URLError(.cannotConnectToHost))
                default:
                    break
                }
            }
            connection.start(queue: queue)
        }
    }

    private func send(_ data: Data) async throws {
        guard let connection else { throw SurfAceRegistrationError.noServer }
        let metadata = NWProtocolWebSocket.Metadata(opcode: .text)
        let context = NWConnection.ContentContext(identifier: "surf-ace-registration", metadata: [metadata])
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            connection.send(content: data, contentContext: context, isComplete: true, completion: .contentProcessed { error in
                if let error {
                    continuation.resume(throwing: URLError(.cannotConnectToHost, userInfo: [NSUnderlyingErrorKey: error]))
                } else {
                    continuation.resume()
                }
            })
        }
    }

    private func receive() async throws -> Data {
        guard let connection else { throw SurfAceRegistrationError.noServer }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Data, Error>) in
            connection.receiveMessage { data, _, _, error in
                if let error {
                    continuation.resume(throwing: URLError(.cannotConnectToHost, userInfo: [NSUnderlyingErrorKey: error]))
                } else if let data {
                    continuation.resume(returning: data)
                } else {
                    continuation.resume(throwing: SurfAceRegistrationError.invalidResponse)
                }
            }
        }
    }
}

@MainActor
enum SurfAceRegistrationTransportFactory {
    static func make(url: URL) -> any SurfAceRegistrationTransport {
        if SurfAceRegistrationEndpoint.usesLocalNumericTransport(url) {
            return SurfAceLocalNumericRegistrationWebSocket(url: url)
        }
        return SurfAceRegistrationWebSocket(url: url)
    }
}

enum SurfAceCentralRegistrationStatus: Equatable {
    case disconnected
    case connecting
    case connected
}

enum SurfAceRegistrationClaim: Equatable, Sendable {
    case surface(surfaceId: String)
    case pane(surfaceId: String, paneId: String, paneLineageId: String)
}

@MainActor
final class SurfAceCentralRegistration {
    @MainActor
    private final class FailureCollector {
        var values: [String] = []
    }

    typealias Snapshot = @MainActor () async throws -> [SurfAceRegistrationSurface]
    typealias Apply = @MainActor ([SurfAceRegistrationAssignment], [SurfAceRegistrationSurface]) async throws -> Void
    typealias InputSnapshot = @MainActor () async throws -> SurfAceRegistrationInput
    typealias ApplyReply = @MainActor (SurfAceRegistrationReply, SurfAceRegistrationInput) async throws -> Void
    typealias ApplyReplySubset = @MainActor (
        SurfAceRegistrationReply, SurfAceRegistrationInput, SurfAceRegistrationInput
    ) async throws -> Bool
    typealias VerifyRegistry = @MainActor (SurfAceRegistryIdentity, [SurfAceRegistrationSurface]) async throws -> Void
    typealias RecoverRefusedRelease = @MainActor (String) async throws -> Void
    typealias RecoverRefusedClaim = @MainActor (SurfAceRegistrationClaim) async throws -> Void

    private enum RecoveryResult {
        case applied
        case retry(SurfAceRegistrationInput)
        case rebind(SurfAceRegistryIdentity, SurfAceRegistrationInput)
    }

    private struct Candidate {
        let url: URL
        let transport: any SurfAceRegistrationTransport
        let phase: String
    }

    private struct IdentifiedCandidate {
        let candidate: Candidate
        let identity: SurfAceRegistryIdentity?
    }
    private let clientId: String
    private let configured: URL?
    private let discover: @MainActor () async -> [URL]
    private let discoveryError: @MainActor () -> String?
    private let makeTransport: @MainActor (URL) -> any SurfAceRegistrationTransport
    private let transportFallbacks: @MainActor (URL) -> [URL]
    private let snapshot: Snapshot
    private let apply: Apply
    private let inputSnapshot: InputSnapshot?
    private let applyReply: ApplyReply?
    private let verifyRegistry: VerifyRegistry
    private let bindRegistry: VerifyRegistry
    private let onError: @MainActor (Error) -> Void
    private let onWarning: @MainActor (String) -> Void
    private let applyReplySubset: ApplyReplySubset?
    private let recoverRefusedRelease: RecoverRefusedRelease?
    private let recoverRefusedClaim: RecoverRefusedClaim?
    private let onVerifiedEndpoint: @MainActor (URL) -> Void
    private var selected: (url: URL, transport: any SurfAceRegistrationTransport)?
    private var loop: Task<Void, Never>?
    private var synchronizationTask: Task<Void, Error>?
    private var synchronizationTaskId: UUID?
    private var stopped = false
    private let onStatusChange: @MainActor (SurfAceCentralRegistrationStatus) -> Void
    private let onConnectionError: @MainActor (String?) -> Void
    private(set) var lastError: String?
    private var lastReportedError: String?
    private(set) var status: SurfAceCentralRegistrationStatus = .disconnected

    private func setStatus(_ next: SurfAceCentralRegistrationStatus) {
        guard status != next else { return }
        status = next
        onStatusChange(next)
    }

    private func setLastError(_ message: String?) {
        guard lastError != message else { return }
        lastError = message
        onConnectionError(message)
    }

    private func reportFailure(
        phase: String,
        endpoint: URL?,
        underlying: String,
        showInStatus: Bool
    ) -> SurfAceCentralRegistrationFailure {
        let failure = SurfAceCentralRegistrationFailure(
            phase: phase,
            endpoint: endpoint.map(surfAceRegistrationEndpointLabel),
            underlying: underlying
        )
        let message = failure.errorDescription ?? underlying
        if lastReportedError != message {
            lastReportedError = message
            onError(failure)
        }
        if showInStatus { setLastError(message) }
        return failure
    }

    init(clientId: String, configured: URL?,
         discover: @escaping @MainActor () async -> [URL],
         discoveryError: @escaping @MainActor () -> String? = { nil },
         makeTransport: @escaping @MainActor (URL) -> any SurfAceRegistrationTransport = { SurfAceRegistrationTransportFactory.make(url: $0) },
         transportFallbacks: @escaping @MainActor (URL) -> [URL] = { _ in [] },
         snapshot: @escaping Snapshot, apply: @escaping Apply,
         verifyRegistry: @escaping VerifyRegistry,
         bindRegistry: VerifyRegistry? = nil,
         inputSnapshot: InputSnapshot? = nil,
         applyReply: ApplyReply? = nil,
         applyReplySubset: ApplyReplySubset? = nil,
         recoverRefusedRelease: RecoverRefusedRelease? = nil,
         recoverRefusedClaim: RecoverRefusedClaim? = nil,
         onError: @escaping @MainActor (Error) -> Void = { _ in },
         onWarning: @escaping @MainActor (String) -> Void = { _ in },
         onStatusChange: @escaping @MainActor (SurfAceCentralRegistrationStatus) -> Void = { _ in },
         onConnectionError: @escaping @MainActor (String?) -> Void = { _ in },
         onVerifiedEndpoint: @escaping @MainActor (URL) -> Void = { _ in }) {
        self.clientId = clientId
        self.configured = configured
        self.discover = discover
        self.discoveryError = discoveryError
        self.makeTransport = makeTransport
        self.transportFallbacks = transportFallbacks
        self.snapshot = snapshot
        self.apply = apply
        self.inputSnapshot = inputSnapshot
        self.applyReply = applyReply
        self.applyReplySubset = applyReplySubset
        self.verifyRegistry = verifyRegistry
        self.bindRegistry = bindRegistry ?? verifyRegistry
        self.recoverRefusedRelease = recoverRefusedRelease
        self.recoverRefusedClaim = recoverRefusedClaim
        self.onError = onError
        self.onWarning = onWarning
        self.onStatusChange = onStatusChange
        self.onConnectionError = onConnectionError
        self.onVerifiedEndpoint = onVerifiedEndpoint
    }

    func synchronize() async throws {
        if let synchronizationTask {
            try await synchronizationTask.value
            return
        }
        let taskId = UUID()
        let task = Task { @MainActor [weak self] in
            guard let self else { throw SurfAceRegistrationError.stopped }
            try await self.synchronizeOnce()
        }
        synchronizationTaskId = taskId
        synchronizationTask = task
        defer {
            if synchronizationTaskId == taskId {
                synchronizationTaskId = nil
                synchronizationTask = nil
            }
        }
        try await task.value
    }

    private func currentInputSnapshot() async throws -> SurfAceRegistrationInput {
        if let inputSnapshot { return try await inputSnapshot() }
        return SurfAceRegistrationInput(
            surfaces: try await snapshot(), pendingPaneReleases: [], pendingWindowReleases: []
        )
    }

    private func applyRegistrationReply(
        _ reply: SurfAceRegistrationReply,
        input: SurfAceRegistrationInput,
        request: SurfAceRegistrationInput
    ) async throws -> Bool {
        for warning in reply.warnings { onWarning(warning) }
        guard !reply.discarded else { return true }
        if let applyReplySubset {
            return try await applyReplySubset(reply, input, request) || reply.needsRetry
        } else if let applyReply {
            try await applyReply(reply, input)
        } else {
            try await apply(reply.assignments, input.surfaces)
        }
        return reply.needsRetry
    }

    private func synchronizeOnce() async throws {
        guard !stopped else { throw SurfAceRegistrationError.stopped }
        if selected == nil { setStatus(.connecting) }
        defer { if status == .connecting { setStatus(.disconnected) } }
        let input = try await currentInputSnapshot()
        guard !stopped else { throw SurfAceRegistrationError.stopped }

        let failures = FailureCollector()
        var selectedRegistrationFailed = false

        // A healthy selected route is the steady-state path. Reuse its socket
        // and avoid a Bonjour scan and identity connections to other addresses
        // on every timer tick.
        if let selected {
            do {
                let identityRead = try await selected.transport.readRegistryIdentity(
                    fallbackIdentity: input.registryIdentity
                )
                for warning in identityRead.warnings { onWarning(warning) }
                let identity = identityRead.identity
                guard identity == nil || identity?.isValid == true else {
                    onWarning("topology_registry_identity_unrecognized")
                    throw SurfAceRegistrationError.registryIdentityMissing
                }
                if let identity {
                    try await bindCandidateRegistry(identity)
                }
                let boundInput = try await currentInputSnapshot()
                if identity != nil, inputSnapshot != nil, boundInput.registryIdentity != identity {
                    onWarning("registration_binding_not_yet_persisted; continuing with current claims")
                }
                selectedRegistrationFailed = true
                try await registerAndApply(using: selected.transport, identity: identity, input: boundInput)
                guard !stopped else { throw SurfAceRegistrationError.stopped }
                setLastError(nil)
                lastReportedError = nil
                setStatus(.connected)
                onVerifiedEndpoint(selected.url)
                return
            } catch {
                if stopped { throw SurfAceRegistrationError.stopped }
                failures.values.append(reportFailure(
                    phase: "reconnect",
                    endpoint: selected.url,
                    underlying: surfAceRegistrationErrorDescription(error),
                    showInStatus: false
                ).errorDescription ?? surfAceRegistrationErrorDescription(error))
                setStatus(.connecting)
            }
        }

        let discovered = await discover()
        if let reason = discoveryError() {
            failures.values.append(reportFailure(
                phase: "discovery",
                endpoint: nil,
                underlying: reason,
                showInStatus: true
            ).errorDescription ?? reason)
        }

        let routeURLs = candidateURLs(discovered: discovered)
        var scanURLs = routeURLs
        if let selected, !scanURLs.contains(where: { $0.0 == selected.url }) {
            scanURLs.append((selected.url, "reconnect"))
        }
        var candidates: [Candidate] = []
        var seen = Set<String>()
        for (url, phase) in scanURLs where (url.scheme == "ws" || url.scheme == "wss") {
            guard seen.insert(url.absoluteString).inserted else { continue }
            let transport: any SurfAceRegistrationTransport
            if let selected, selected.url == url {
                transport = selected.transport
            } else {
                transport = makeTransport(url)
            }
            candidates.append(Candidate(url: url, transport: transport, phase: phase))
        }

        var identified: [IdentifiedCandidate] = []
        for candidate in candidates {
            do {
                let identityRead = try await candidate.transport.readRegistryIdentity(
                    fallbackIdentity: input.registryIdentity
                )
                for warning in identityRead.warnings { onWarning(warning) }
                if identityRead.identity?.isValid == false {
                    onWarning("topology_registry_identity_unrecognized")
                }
                let identity = identityRead.identity?.isValid == true ? identityRead.identity : nil
                identified.append(.init(candidate: candidate, identity: identity))
            } catch {
                failures.values.append(reportFailure(
                    phase: "identity",
                    endpoint: candidate.url,
                    underlying: surfAceRegistrationErrorDescription(error),
                    showInStatus: false
                ).errorDescription ?? surfAceRegistrationErrorDescription(error))
            }
        }

        guard !stopped else { throw SurfAceRegistrationError.stopped }

        let matching = input.registryIdentity.flatMap { identity in
            identified.first(where: { $0.identity == identity })
        }
        // Prefer the current registry while it is discoverable. Otherwise prefer
        // an identified registry; if every topology reply is incomplete, still
        // register with the discovered server and leave its claims unbound.
        guard let preferredCandidate = matching ?? identified.first(where: { $0.identity != nil }) ?? identified.first else {
            let reason = failures.values.isEmpty
                ? "Bonjour found no _surf-ace._tcp service with role=server v=1 ws=/ws"
                : failures.values.joined(separator: "; ")
            let failure = SurfAceCentralRegistrationFailure(phase: "retry", endpoint: nil, underlying: reason)
            setLastError(failure.errorDescription)
            if lastReportedError != failure.errorDescription {
                lastReportedError = failure.errorDescription
                onError(failure)
            }
            for candidate in candidates { candidate.transport.close() }
            if let selected { selected.transport.close() }
            selected = nil
            throw failure
        }
        let selectedIdentity = preferredCandidate.identity

        for identifiedCandidate in identified where identifiedCandidate.identity == selectedIdentity {
            let candidate = identifiedCandidate.candidate
            if selectedRegistrationFailed, let selected, selected.url == candidate.url,
               input.registryIdentity == identifiedCandidate.identity { continue }
            do {
                if let identity = identifiedCandidate.identity {
                    try await bindCandidateRegistry(identity)
                }
                let boundInput = try await currentInputSnapshot()
                if identifiedCandidate.identity != nil, inputSnapshot != nil,
                   boundInput.registryIdentity != identifiedCandidate.identity {
                    onWarning("registration_binding_not_yet_persisted; continuing with current claims")
                }
                try await registerAndApply(
                    using: candidate.transport,
                    identity: identifiedCandidate.identity,
                    input: boundInput
                )
                guard !stopped else { throw SurfAceRegistrationError.stopped }
                for other in candidates where other.transport !== candidate.transport {
                    other.transport.close()
                }
                if let prior = selected, prior.transport !== candidate.transport {
                    prior.transport.close()
                }
                selected = (candidate.url, candidate.transport)
                setLastError(nil)
                lastReportedError = nil
                setStatus(.connected)
                onVerifiedEndpoint(candidate.url)
                return
            } catch {
                if stopped {
                    for other in candidates {
                        if let selected, other.transport === selected.transport { continue }
                        other.transport.close()
                    }
                    throw SurfAceRegistrationError.stopped
                }
                failures.values.append(reportFailure(
                    phase: candidate.phase,
                    endpoint: candidate.url,
                    underlying: surfAceRegistrationErrorDescription(error),
                    showInStatus: false
                ).errorDescription ?? surfAceRegistrationErrorDescription(error))
            }
        }

        for candidate in candidates { candidate.transport.close() }
        if let selected { selected.transport.close() }
        self.selected = nil
        setStatus(.disconnected)
        let reason = failures.values.isEmpty
            ? "registry registration failed for every endpoint with identity \(selectedIdentity.map { "\($0.allocatorId)/\($0.fleetId)" } ?? "unreported")"
            : failures.values.joined(separator: "; ")
        throw reportFailure(phase: "retry", endpoint: nil, underlying: reason, showInStatus: true)
    }

    private func candidateURLs(discovered: [URL]) -> [(URL, String)] {
        var result: [(URL, String)] = []
        var seen = Set<String>()
        func append(_ url: URL, _ phase: String) {
            guard seen.insert(url.absoluteString).inserted else { return }
            result.append((url, phase))
        }
        if let configured { append(configured, "configured") }
        for url in discovered {
            // Bonjour supplies resolved addresses for a role=server service.
            for address in transportFallbacks(url) { append(address, "transport_address") }
            append(url, "discovery")
        }
        return result
    }

    private func bindCandidateRegistry(
        _ identity: SurfAceRegistryIdentity
    ) async throws {
        guard identity.isValid else {
            onWarning("topology_registry_identity_unrecognized")
            return
        }
        for _ in 0..<3 {
            let currentSurfaces = try await snapshot()
            let currentInput = try await currentInputSnapshot()
            do {
                if currentInput.registryIdentity == identity {
                    try await verifyRegistry(identity, currentSurfaces)
                } else {
                    try await bindRegistry(identity, currentSurfaces)
                }
                return
            } catch SurfAceRegistrationError.topologyChanged {
                onWarning("registration_local_snapshot_changed_during_binding; retrying")
                continue
            }
        }
        onWarning("registration_binding_snapshot_unstable; continuing with best available claims")
    }

    private func registerAndApply(
        using transport: any SurfAceRegistrationTransport,
        identity: SurfAceRegistryIdentity?,
        input: SurfAceRegistrationInput
    ) async throws {
        var current = input
        var currentIdentity = identity
        var registryIdentityConfirmedForReleases = false
        let maximumRecoveryAttempts = 1 + input.pendingPaneReleases.count
            + input.pendingWindowReleases.count
            + input.surfaces.reduce(0) { $0 + 1 + $1.panes.count }
        for _ in 0..<maximumRecoveryAttempts {
            guard !stopped else { throw SurfAceRegistrationError.stopped }
            do {
                let request = !registryIdentityConfirmedForReleases
                    && (!current.pendingPaneReleases.isEmpty || !current.pendingWindowReleases.isEmpty)
                    ? current.withoutReleases : current
                let reply = try await transport.register(
                    clientId: clientId, input: request, expectedIdentity: currentIdentity
                )
                if let replyIdentity = reply.registryIdentity, replyIdentity != currentIdentity {
                    onWarning("registration_registry_identity_changed; rebinding and retrying")
                    try await bindRegistry(replyIdentity, try await snapshot())
                    currentIdentity = replyIdentity
                    current = try await currentInputSnapshot()
                    continue
                }
                if !reply.discarded, currentIdentity != nil,
                   reply.registryIdentity == nil || reply.registryIdentity == currentIdentity {
                    registryIdentityConfirmedForReleases = true
                }
                if try await applyRegistrationReply(reply, input: current, request: request) {
                    current = try await currentInputSnapshot()
                    continue
                }
                return
            } catch let error as SurfAceRegistrationError {
                guard case .serverRejected = error else {
                    if !current.pendingPaneReleases.isEmpty || !current.pendingWindowReleases.isEmpty {
                        let noReleases = current.withoutReleases
                        do {
                            let reply = try await transport.register(
                                clientId: clientId, input: noReleases, expectedIdentity: currentIdentity
                            )
                            if try await applyRegistrationReply(reply, input: current, request: noReleases) {
                                current = try await currentInputSnapshot()
                                continue
                            }
                            return
                        } catch {
                            throw error
                        }
                    }
                    throw error
                }

                switch try await recoverSemanticRejection(
                    using: transport, identity: currentIdentity, input: current
                ) {
                case .applied:
                    return
                case .retry(let updated):
                    current = updated
                case .rebind(let updatedIdentity, let updated):
                    currentIdentity = updatedIdentity
                    current = updated
                }
            } catch {
                if !current.pendingPaneReleases.isEmpty || !current.pendingWindowReleases.isEmpty {
                    let noReleases = current.withoutReleases
                    let reply = try await transport.register(
                        clientId: clientId, input: noReleases, expectedIdentity: currentIdentity
                    )
                    if try await applyRegistrationReply(reply, input: current, request: noReleases) {
                        current = try await currentInputSnapshot()
                        continue
                    }
                    return
                }
                throw error
            }
        }
        onWarning("registration_recovery_attempts_exhausted; continuing with confirmed claims")
    }

    private func applyRecoveredReply(
        _ reply: SurfAceRegistrationReply,
        input: SurfAceRegistrationInput,
        request: SurfAceRegistrationInput,
        identity: SurfAceRegistryIdentity?
    ) async throws -> RecoveryResult {
        if let replyIdentity = reply.registryIdentity, replyIdentity != identity {
            onWarning("registration_registry_identity_changed; rebinding and retrying")
            try await bindRegistry(replyIdentity, try await snapshot())
            return .rebind(replyIdentity, try await currentInputSnapshot())
        }
        if try await applyRegistrationReply(reply, input: input, request: request) {
            return .retry(try await currentInputSnapshot())
        }
        return .applied
    }

    private func recoverSemanticRejection(
        using transport: any SurfAceRegistrationTransport,
        identity: SurfAceRegistryIdentity?,
        input: SurfAceRegistrationInput
    ) async throws -> RecoveryResult {
        let withoutReleases = input.withoutReleases
        var acceptedSurfaceReply: SurfAceRegistrationReply?
        do {
            acceptedSurfaceReply = try await transport.register(
                clientId: clientId, input: withoutReleases, expectedIdentity: identity
            )
        } catch let error as SurfAceRegistrationError {
            guard case .serverRejected = error else { throw error }
            let empty = withoutReleases.request(surfaces: [])
            do {
                _ = try await transport.register(clientId: clientId, input: empty, expectedIdentity: identity)
            } catch let error as SurfAceRegistrationError {
                guard case .serverRejected = error else { throw error }
                onWarning("registration_claims_refused; preserving saved content and pending releases")
                return .applied
            } catch {
                throw error
            }

            var accepted: [SurfAceRegistrationSurface] = []
            for surface in input.surfaces {
                let surfaceOnly = SurfAceRegistrationSurface(surfaceId: surface.surfaceId, panes: [])
                let surfacePrefix = accepted + [surfaceOnly]
                do {
                    _ = try await transport.register(
                        clientId: clientId,
                        input: withoutReleases.request(surfaces: surfacePrefix),
                        expectedIdentity: identity
                    )
                } catch let probeError as SurfAceRegistrationError {
                    guard case .serverRejected = probeError else { throw probeError }
                    guard let recoverRefusedClaim else {
                        onWarning("registration_surface_claim_refused; keeping its saved state")
                        return .applied
                    }
                    try await recoverRefusedClaim(.surface(surfaceId: surface.surfaceId))
                    return .retry(try await currentInputSnapshot())
                } catch {
                    // The probe outcome is unknown; retain every claim and try
                    // the complete request once before relying on later retries.
                    let reply = try await transport.register(
                        clientId: clientId, input: withoutReleases, expectedIdentity: identity
                    )
                    return try await applyRecoveredReply(
                        reply, input: input, request: withoutReleases, identity: identity
                    )
                }

                var panes = [SurfAceRegistrationSurface.Pane]()
                for pane in surface.panes {
                    let expanded = SurfAceRegistrationSurface(surfaceId: surface.surfaceId, panes: panes + [pane])
                    do {
                        _ = try await transport.register(
                            clientId: clientId,
                            input: withoutReleases.request(surfaces: accepted + [expanded]),
                            expectedIdentity: identity
                        )
                    } catch let probeError as SurfAceRegistrationError {
                        guard case .serverRejected = probeError else { throw probeError }
                        guard let recoverRefusedClaim else {
                            onWarning("registration_pane_claim_refused; keeping the pane usable")
                            return .applied
                        }
                        try await recoverRefusedClaim(.pane(
                            surfaceId: surface.surfaceId, paneId: pane.paneId,
                            paneLineageId: pane.paneLineageId
                        ))
                        return .retry(try await currentInputSnapshot())
                    } catch {
                        let reply = try await transport.register(
                            clientId: clientId, input: withoutReleases, expectedIdentity: identity
                        )
                        return try await applyRecoveredReply(
                            reply, input: input, request: withoutReleases, identity: identity
                        )
                    }
                    panes.append(pane)
                }
                accepted.append(SurfAceRegistrationSurface(surfaceId: surface.surfaceId, panes: panes))
            }
            acceptedSurfaceReply = try await transport.register(
                clientId: clientId, input: withoutReleases, expectedIdentity: identity
            )
        }

        guard let acceptedSurfaceReply else { throw SurfAceRegistrationError.invalidResponse }
        guard !input.pendingPaneReleases.isEmpty || !input.pendingWindowReleases.isEmpty else {
            return try await applyRecoveredReply(
                acceptedSurfaceReply, input: input, request: withoutReleases, identity: identity
            )
        }

        var acceptedWindows: [SurfAceWindowReleaseRequest] = []
        var acceptedPanes: [SurfAcePaneReleaseRequest] = []
        var lastReply = acceptedSurfaceReply
        for release in input.pendingWindowReleases {
            do {
                lastReply = try await transport.register(
                    clientId: clientId,
                    input: input.request(
                        pendingPaneReleases: acceptedPanes,
                        pendingWindowReleases: acceptedWindows + [release]
                    ), expectedIdentity: identity
                )
            } catch let probeError as SurfAceRegistrationError {
                guard case .serverRejected = probeError else { throw probeError }
                guard let recoverRefusedRelease else {
                    onWarning("registration_window_release_refused; keeping its evidence pending")
                    return try await applyRecoveredReply(
                        acceptedSurfaceReply, input: input, request: withoutReleases, identity: identity
                    )
                }
                try await recoverRefusedRelease(release.releaseId)
                return .retry(try await currentInputSnapshot())
            } catch {
                return try await applyRecoveredReply(
                    acceptedSurfaceReply, input: input, request: withoutReleases, identity: identity
                )
            }
            acceptedWindows.append(release)
        }
        for release in input.pendingPaneReleases {
            do {
                lastReply = try await transport.register(
                    clientId: clientId,
                    input: input.request(
                        pendingPaneReleases: acceptedPanes + [release],
                        pendingWindowReleases: acceptedWindows
                    ), expectedIdentity: identity
                )
            } catch let probeError as SurfAceRegistrationError {
                guard case .serverRejected = probeError else { throw probeError }
                guard let recoverRefusedRelease else {
                    onWarning("registration_pane_release_refused; keeping its evidence pending")
                    return try await applyRecoveredReply(
                        acceptedSurfaceReply, input: input, request: withoutReleases, identity: identity
                    )
                }
                try await recoverRefusedRelease(release.releaseId)
                return .retry(try await currentInputSnapshot())
            } catch {
                return try await applyRecoveredReply(
                    acceptedSurfaceReply, input: input, request: withoutReleases, identity: identity
                )
            }
            acceptedPanes.append(release)
        }
        return try await applyRecoveredReply(lastReply, input: input, request: input, identity: identity)
    }

    func claimPaneLabel(surfaceId: String, paneId: Int64, paneLineageId: String) async throws -> SurfAcePaneAllocation {
        guard !stopped else { throw SurfAceRegistrationError.noServer }
        var input = try await currentInputSnapshot()
        if !input.pendingPaneReleases.isEmpty || !input.pendingWindowReleases.isEmpty {
            try await synchronize()
            input = try await currentInputSnapshot()
            guard input.pendingPaneReleases.isEmpty, input.pendingWindowReleases.isEmpty else {
                throw SurfAceRegistrationError.noServer
            }
        }
        guard let selected, status == .connected else {
            throw SurfAceRegistrationError.noServer
        }
        // Use a separate socket so a periodic registration response cannot be
        // consumed by this claim while either request is suspended.
        let transport = makeTransport(selected.url)
        defer { transport.close() }
        let latest = try await currentInputSnapshot()
        guard latest.pendingPaneReleases.isEmpty, latest.pendingWindowReleases.isEmpty else {
            throw SurfAceRegistrationError.noServer
        }
        let identityRead = try await transport.readRegistryIdentity(fallbackIdentity: latest.registryIdentity)
        for warning in identityRead.warnings { onWarning(warning) }
        guard let identity = identityRead.identity, identity.isValid else {
            onWarning("pane_claim_registry_identity_unavailable")
            return SurfAcePaneAllocation(
                paneLabel: 0, allocationGeneration: nil,
                warnings: ["pane_claim_registry_identity_unavailable"]
            )
        }
        try await bindCandidateRegistry(identity)
        let boundInput = try await currentInputSnapshot()
        guard boundInput.registryIdentity == identity else {
            onWarning("pane_claim_binding_not_persisted; keeping the pane usable without a new label")
            return SurfAcePaneAllocation(
                paneLabel: 0, allocationGeneration: nil,
                warnings: ["pane_claim_binding_not_persisted"]
            )
        }
        let allocation = try await transport.claimPaneLabel(
            clientId: clientId, surfaceId: surfaceId, paneId: paneId, paneLineageId: paneLineageId
        )
        for warning in allocation.warnings { onWarning(warning) }
        return allocation
    }

    private func attempt(
        _ url: URL,
        input: SurfAceRegistrationInput,
        failures: FailureCollector,
        phase: String = "registration"
    ) async throws -> Bool {
        guard !stopped else { throw SurfAceRegistrationError.stopped }
        guard url.scheme == "ws" || url.scheme == "wss" else { return false }
        if selected == nil { setStatus(.connecting) }
        let candidate = makeTransport(url)
        do {
            let identityRead = try await candidate.readRegistryIdentity(fallbackIdentity: input.registryIdentity)
            for warning in identityRead.warnings { onWarning(warning) }
            if let identity = identityRead.identity { try await bindCandidateRegistry(identity) }
            let latest = try await currentInputSnapshot()
            try await registerAndApply(using: candidate, identity: identityRead.identity, input: latest)
            guard !stopped else { throw SurfAceRegistrationError.stopped }
            selected?.transport.close()
            selected = (url, candidate)
            setLastError(nil)
            lastReportedError = nil
            setStatus(.connected)
            onVerifiedEndpoint(url)
            return true
        } catch {
            candidate.close()
            if selected == nil { setStatus(.disconnected) }
            let failure = reportFailure(
                phase: phase,
                endpoint: url,
                underlying: surfAceRegistrationErrorDescription(error),
                showInStatus: selected == nil
            )
            failures.values.append(failure.errorDescription ?? surfAceRegistrationErrorDescription(error))
            if stopped { throw SurfAceRegistrationError.stopped }
            return false
        }
    }

    func start() {
        guard loop == nil, !stopped else { return }
        loop = Task { [weak self] in
            while let self, !self.stopped {
                do { try await self.synchronize() } catch {
                    let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                    if self.lastReportedError != message {
                        self.lastReportedError = message
                        self.onError(error)
                    }
                }
                do { try await Task.sleep(for: .seconds(2)) } catch { return }
            }
        }
    }

    func stop() {
        stopped = true
        loop?.cancel()
        loop = nil
        selected?.transport.close()
        selected = nil
        setStatus(.disconnected)
    }
}

@MainActor
final class SurfAceCentralDiscovery: NSObject, @preconcurrency NetServiceBrowserDelegate, @preconcurrency NetServiceDelegate {
    private let makeBrowser: @MainActor () -> NetServiceBrowser
    private let sleep: @MainActor (Duration) async throws -> Void
    private let lifecycle = SurfAceCentralDiscoveryLifecycle()
    private var activeBrowser: (browser: NetServiceBrowser, generation: UInt64)?
    private var services: [ObjectIdentifier: (service: NetService, generation: UInt64)] = [:]
    private var urls: [String: URL] = [:]
    private var addresses: [URL: [URL]] = [:]
    private var runningGeneration: UInt64?
    private(set) var lastError: String?

    init(makeBrowser: @escaping @MainActor () -> NetServiceBrowser = { NetServiceBrowser() },
         sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.makeBrowser = makeBrowser
        self.sleep = sleep
        super.init()
    }

    func transportURLs(for url: URL) -> [URL] { addresses[url] ?? [] }

    func discover() async -> [URL] {
        guard runningGeneration == nil, !Task.isCancelled else { return [] }
        let generation = lifecycle.beginBrowsing()
        runningGeneration = generation
        lastError = nil
        addresses.removeAll()
        urls.removeAll()
        let browser = makeBrowser()
        activeBrowser = (browser, generation)
        browser.delegate = self
        browser.searchForServices(ofType: "_surf-ace._tcp.", inDomain: "local.")
        let browseCancelled: Bool
        do {
            try await sleep(.milliseconds(1500))
            browseCancelled = false
        } catch {
            browseCancelled = true
        }
        closeIntake(browser: browser, generation: generation)
        if browseCancelled {
            lifecycle.cancel(generation: generation)
        } else if !lifecycle.isComplete(generation: generation) {
            let timeout = Task { @MainActor [weak self] in
                guard let self else { return }
                do {
                    try await sleep(.seconds(2))
                    lifecycle.resolutionTimedOut(generation: generation)
                } catch { }
            }
            await withTaskCancellationHandler {
                await lifecycle.waitUntilComplete(generation: generation)
            } onCancel: {
                Task { @MainActor [weak self] in self?.lifecycle.cancel(generation: generation) }
            }
            timeout.cancel()
        }
        finishServices(generation: generation)
        let result = urls.sorted { $0.key < $1.key }.map(\.value)
        if result.isEmpty && lastError == nil {
            lastError = "Bonjour found no _surf-ace._tcp service with role=server v=1 ws=/ws"
        }
        urls.removeAll()
        if runningGeneration == generation { runningGeneration = nil }
        return result
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didFind service: NetService, moreComing: Bool) {
        guard let activeBrowser,
              activeBrowser.browser === browser,
              lifecycle.found(service, generation: activeBrowser.generation) else {
            service.stop()
            service.delegate = nil
            return
        }
        services[ObjectIdentifier(service)] = (service, activeBrowser.generation)
        service.delegate = self
        service.resolve(withTimeout: 1)
    }

    func netServiceDidResolveAddress(_ sender: NetService) {
        let identifier = ObjectIdentifier(sender)
        guard let owned = services[identifier],
              lifecycle.resolutionSucceeded(sender, generation: owned.generation) else { return }
        services.removeValue(forKey: identifier)
        defer {
            sender.stop()
            sender.delegate = nil
        }
        storeCandidate(from: sender)
    }

    func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
        let identifier = ObjectIdentifier(sender)
        guard let owned = services[identifier],
              lifecycle.resolutionFailed(sender, generation: owned.generation) else { return }
        services.removeValue(forKey: identifier)
        lastError = "Bonjour could not resolve SRV target for \(sender.name): \(diagnosticFields(errorDict))"
        // NetService can provide numeric DNS-SD addresses even when its target
        // hostname lookup fails. Registration tries those addresses first.
        storeCandidate(from: sender)
        sender.stop()
        sender.delegate = nil
    }

    func netServiceBrowser(_ browser: NetServiceBrowser, didNotSearch errorDict: [String: NSNumber]) {
        guard let activeBrowser, activeBrowser.browser === browser else { return }
        lastError = "Bonjour browse failed: \(diagnosticFields(errorDict))"
        closeIntake(browser: browser, generation: activeBrowser.generation)
        lifecycle.cancel(generation: activeBrowser.generation)
    }

    static func localTransportURL(host: String, port: Int, path: String) -> URL? {
        SurfAceCentralDiscoveryLifecycle.localTransportURL(host: host, port: port, path: path)
    }

    private func storeCandidate(from sender: NetService) {
        guard let data = sender.txtRecordData() else {
            lastError = "Bonjour service \(sender.name) has no TXT record"
            return
        }
        let txt = NetService.dictionary(fromTXTRecord: data)
        let role = txt["role"].flatMap { String(data: $0, encoding: .utf8) }
        guard role == "server" else { return }
        let version = txt["v"].flatMap { String(data: $0, encoding: .utf8) } ?? "missing"
        let path = txt["ws"].flatMap { String(data: $0, encoding: .utf8) } ?? "missing"
        guard version == "1", path == "/ws" else {
            lastError = "Bonjour service \(sender.name) rejected: expected role=server v=1 ws=/ws, received v=\(version) ws=\(path)"
            return
        }
        guard let host = sender.hostName, sender.port > 0 else {
            lastError = "Bonjour service \(sender.name) has no resolved SRV target and port"
            return
        }
        let normalizedHost = (host.hasSuffix(".") ? String(host.dropLast()) : host).lowercased()
        guard normalizedHost != "0.0.0.0", normalizedHost != "::", normalizedHost != "0:0:0:0:0:0:0:0" else {
            lastError = "Bonjour service \(sender.name) rejected: SRV target \(host) is a wildcard address, not a client destination"
            return
        }
        guard let url = Self.localTransportURL(host: host, port: sender.port, path: path) else {
            lastError = "Bonjour service \(sender.name) has an invalid SRV target, port, or ws path"
            return
        }
        urls[sender.name] = url
        addresses[url] = numericTransportURLs(from: sender.addresses ?? [], basedOn: url)
    }

    private func numericTransportURLs(from addresses: [Data], basedOn url: URL) -> [URL] {
        addresses.compactMap { data in
            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            let result = data.withUnsafeBytes { bytes -> Int32 in
                guard let base = bytes.baseAddress, bytes.count >= MemoryLayout<sockaddr>.size else { return -1 }
                return getnameinfo(base.assumingMemoryBound(to: sockaddr.self), socklen_t(bytes.count),
                    &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST)
            }
            guard result == 0 else { return nil }
            guard var transport = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
            transport.host = String(cString: host)
            return transport.url
        }.sorted { left, right in
            let leftIsIPv4 = left.host.map { $0.contains(":") == false } ?? false
            let rightIsIPv4 = right.host.map { $0.contains(":") == false } ?? false
            return leftIsIPv4 && !rightIsIPv4
        }
    }

    private func diagnosticFields(_ fields: [String: NSNumber]) -> String {
        fields.keys.sorted().map { "\($0)=\(fields[$0] ?? 0)" }.joined(separator: ",")
    }

    private func closeIntake(browser: NetServiceBrowser, generation: UInt64) {
        guard let activeBrowser,
              activeBrowser.browser === browser,
              activeBrowser.generation == generation else { return }
        browser.stop()
        browser.delegate = nil
        self.activeBrowser = nil
        lifecycle.endBrowsing(generation: generation)
    }

    private func finishServices(generation: UInt64) {
        let identifiers = services.compactMap { identifier, owned in
            owned.generation == generation ? identifier : nil
        }
        for identifier in identifiers {
            guard let owned = services.removeValue(forKey: identifier) else { continue }
            owned.service.stop()
            owned.service.delegate = nil
        }
    }
}
