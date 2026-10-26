import Foundation
import Darwin
import Network

struct SurfAceRegistrationSurface: Codable, Equatable, Sendable {
    struct Pane: Codable, Equatable, Sendable {
        let paneId: String
        let paneLineageId: String
        let paneLabel: Int64
        let allocationGeneration: Int64?

        init(paneId: String, paneLineageId: String, paneLabel: Int64, allocationGeneration: Int64? = nil) {
            self.paneId = paneId
            self.paneLineageId = paneLineageId
            self.paneLabel = paneLabel
            self.allocationGeneration = allocationGeneration
        }
    }
    let surfaceId: String
    let panes: [Pane]

    static func snapshot(_ state: SurfAceLocklessAuthorityState) -> [Self] {
        state.liveSurfaces.values.sorted { $0.surfaceId < $1.surfaceId }.map { surface in
            Self(surfaceId: surface.surfaceId, panes: surface.panes.values.sorted { $0.paneId < $1.paneId }.map {
                Pane(
                    paneId: String($0.paneId), paneLineageId: $0.paneLineageId,
                    paneLabel: $0.paneLabel, allocationGeneration: $0.allocationGeneration
                )
            })
        }
    }
}

struct SurfAceRegistrationAssignment: Codable, Equatable, Sendable {
    let surfaceId: String
    let windowLabel: String
    let windowAllocationGeneration: Int64?
    let panes: [SurfAceRegistrationSurface.Pane]

    init(
        surfaceId: String,
        windowLabel: String,
        windowAllocationGeneration: Int64? = nil,
        panes: [SurfAceRegistrationSurface.Pane] = []
    ) {
        self.surfaceId = surfaceId
        self.windowLabel = windowLabel
        self.windowAllocationGeneration = windowAllocationGeneration
        self.panes = panes
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
}

struct SurfAceRegistrationReply: Equatable, Sendable {
    let assignments: [SurfAceRegistrationAssignment]
    let projection: SurfAceRegistrationProjection
}

struct SurfAcePaneAllocation: Equatable, Sendable {
    let paneLabel: Int64
    let allocationGeneration: Int64?
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
        let id: String
        let op: String
        let type: String
        let v: Int
        let ok: Bool
        let payload: Payload?
    }

    static func topologyData(id: String) throws -> Data {
        try JSONEncoder().encode(TopologyRequest(id: id))
    }

    static func registryIdentity(from data: Data, requestId: String) throws -> SurfAceRegistryIdentity {
        let response = try JSONDecoder().decode(TopologyResponse.self, from: data)
        guard response.id == requestId, response.op == "fleet.topology", response.type == "response",
              response.v == 1, response.ok, let identity = response.payload?.registryIdentity,
              identity.isValid else { throw SurfAceRegistrationError.registryIdentityMissing }
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
            let paneLabel: Int64
            let allocationGeneration: Int64?
        }
        let id: String
        let op: String
        let ok: Bool
        let payload: Payload?
        let error: ErrorPayload?
    }
    struct Payload: Codable {
        let clientId: String
        let allocationGenerationV1: Bool
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
            let clientId: String
            let registryIdentity: SurfAceRegistryIdentity?
            let surfaces: [SurfAceRegistrationAssignment]
            let directEndpoint: String?
            let prePairDescribeV1: Bool?
            let allocationGenerationV1: Bool?
            let endpointLease: SurfAceEndpointLease?
            let completedPaneReleaseIds: [String]?
            let completedWindowReleaseIds: [String]?
        }
        let id: String
        let op: String
        let ok: Bool
        let payload: Payload?
        let error: ErrorPayload?
    }

    static func requestData(clientId: String, surfaces: [SurfAceRegistrationSurface], id: String) throws -> Data {
        try JSONEncoder().encode(Request(id: id, payload: Payload(
            clientId: clientId, allocationGenerationV1: false,
            pendingPaneReleases: [], pendingWindowReleases: [], surfaces: surfaces
        )))
    }

    static func requestData(clientId: String, input: SurfAceRegistrationInput, id: String) throws -> Data {
        try JSONEncoder().encode(Request(id: id, payload: Payload(
            clientId: clientId, allocationGenerationV1: true,
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
        expectedAllocationGenerationV1: Bool
    ) throws -> SurfAcePaneAllocation {
        let response = try JSONDecoder().decode(PaneClaimResponse.self, from: data)
        guard response.id == requestId, response.op == "pane.claim" else {
            throw SurfAceRegistrationError.invalidResponse
        }
        guard response.ok else {
            throw SurfAceRegistrationError.paneClaimRejected(
                code: response.error?.code,
                message: response.error?.message
            )
        }
        guard let payload = response.payload, payload.paneLabel > 0,
              expectedAllocationGenerationV1
                ? (payload.allocationGeneration.map { $0 > 0 && $0 <= 9_007_199_254_740_991 } == true)
                : payload.allocationGeneration == nil else {
            throw SurfAceRegistrationError.invalidResponse
        }
        return SurfAcePaneAllocation(
            paneLabel: payload.paneLabel,
            allocationGeneration: payload.allocationGeneration
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
        try registration(
            from: data,
            requestId: requestId,
            clientId: clientId,
            surfaces: surfaces,
            expectedIdentity: expectedIdentity
        ).assignments
    }

    static func registration(
        from data: Data,
        requestId: String,
        clientId: String,
        surfaces: [SurfAceRegistrationSurface],
        expectedIdentity: SurfAceRegistryIdentity,
        expectedDirectEndpoint: String? = nil,
        expectedPrePairDescribeV1: Bool = false,
        expectedAllocationGenerationV1: Bool = false,
        expectedPaneReleaseIds: [String] = [],
        expectedWindowReleaseIds: [String] = []
    ) throws -> SurfAceRegistrationReply {
        let response = try JSONDecoder().decode(Response.self, from: data)
        guard response.id == requestId, response.op == "client.register" else {
            throw SurfAceRegistrationError.invalidResponse
        }
        guard response.ok else {
            throw SurfAceRegistrationError.serverRejected(
                code: response.error?.code,
                message: response.error?.message
            )
        }
        guard let payload = response.payload, payload.clientId == clientId,
              let identity = payload.registryIdentity, identity.isValid,
              identity == expectedIdentity,
              payload.surfaces.count == surfaces.count,
              Set(payload.surfaces.map(\.surfaceId)) == Set(surfaces.map(\.surfaceId)) else {
            throw SurfAceRegistrationError.invalidResponse
        }

        let directEndpoint = payload.directEndpoint
        let prePairDescribeV1 = payload.prePairDescribeV1 ?? false
        let allocationGenerationV1 = payload.allocationGenerationV1 ?? false
        let endpointLease = payload.endpointLease
        let completedPaneReleaseIds = payload.completedPaneReleaseIds ?? []
        let completedWindowReleaseIds = payload.completedWindowReleaseIds ?? []
        guard !expectedPrePairDescribeV1 || expectedDirectEndpoint != nil,
              directEndpoint == expectedDirectEndpoint,
              prePairDescribeV1 == expectedPrePairDescribeV1,
              allocationGenerationV1 == expectedAllocationGenerationV1,
              completedPaneReleaseIds == expectedPaneReleaseIds,
              completedWindowReleaseIds == expectedWindowReleaseIds,
              Set(completedPaneReleaseIds).count == completedPaneReleaseIds.count,
              Set(completedWindowReleaseIds).count == completedWindowReleaseIds.count,
              Set(completedPaneReleaseIds + completedWindowReleaseIds).count
                == completedPaneReleaseIds.count + completedWindowReleaseIds.count,
              expectedDirectEndpoint.map(isSupportedDirectEndpoint) ?? true,
              endpointLease.map(\.isValid) ?? true,
              (endpointLease != nil) == (expectedDirectEndpoint != nil && expectedPrePairDescribeV1),
              payload.surfaces.allSatisfy({ assignment in
                  guard expectedAllocationGenerationV1 else {
                      return assignment.windowAllocationGeneration == nil
                          && assignment.panes.allSatisfy { $0.allocationGeneration == nil }
                  }
                  return assignment.windowAllocationGeneration.map { $0 > 0 && $0 <= 9_007_199_254_740_991 } == true
                      && assignment.panes.allSatisfy {
                          $0.allocationGeneration.map { $0 > 0 && $0 <= 9_007_199_254_740_991 } == true
                      }
              }) else {
            throw SurfAceRegistrationError.invalidResponse
        }
        return SurfAceRegistrationReply(
            assignments: payload.surfaces,
            projection: SurfAceRegistrationProjection(
                directEndpoint: directEndpoint,
                prePairDescribeV1: prePairDescribeV1,
                allocationGenerationV1: allocationGenerationV1,
                endpointLease: endpointLease,
                completedPaneReleaseIds: completedPaneReleaseIds,
                completedWindowReleaseIds: completedWindowReleaseIds
            )
        )
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
    func register(clientId: String, surfaces: [SurfAceRegistrationSurface],
                  expectedIdentity: SurfAceRegistryIdentity) async throws -> [SurfAceRegistrationAssignment]
    func register(clientId: String, input: SurfAceRegistrationInput,
                  expectedIdentity: SurfAceRegistryIdentity) async throws -> SurfAceRegistrationReply
    func claimPaneLabel(clientId: String, surfaceId: String, paneId: Int64,
                        paneLineageId: String) async throws -> SurfAcePaneAllocation
    func close()
}

extension SurfAceRegistrationTransport {
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
        let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let timeout = Task { [socket] in
            do {
                try await Task.sleep(for: .seconds(2))
                socket.cancel(with: .goingAway, reason: nil)
            } catch { }
        }
        defer { timeout.cancel() }
        try await socket.send(.data(SurfAceRegistrationWire.topologyData(id: id)))
        let message = try await socket.receive()
        let data: Data
        switch message {
        case .data(let value): data = value
        case .string(let value): data = Data(value.utf8)
        @unknown default: throw SurfAceRegistrationError.invalidResponse
        }
        return try SurfAceRegistrationWire.registryIdentity(from: data, requestId: id)
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
        let message = try await socket.receive()
        let data: Data
        switch message {
        case .data(let value): data = value
        case .string(let value): data = Data(value.utf8)
        @unknown default: throw SurfAceRegistrationError.invalidResponse
        }
        return try SurfAceRegistrationWire.assignments(from: data, requestId: id, clientId: clientId,
                                                        surfaces: surfaces, expectedIdentity: expectedIdentity)
    }

    func register(clientId: String, input: SurfAceRegistrationInput,
                  expectedIdentity: SurfAceRegistryIdentity) async throws -> SurfAceRegistrationReply {
        let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        let timeout = Task { [socket] in
            do {
                try await Task.sleep(for: .seconds(2))
                socket.cancel(with: .goingAway, reason: nil)
            } catch { }
        }
        defer { timeout.cancel() }
        try await socket.send(.data(SurfAceRegistrationWire.requestData(clientId: clientId, input: input, id: id)))
        let message = try await socket.receive()
        let data: Data
        switch message {
        case .data(let value): data = value
        case .string(let value): data = Data(value.utf8)
        @unknown default: throw SurfAceRegistrationError.invalidResponse
        }
        return try SurfAceRegistrationWire.registration(
            from: data, requestId: id, clientId: clientId, surfaces: input.surfaces,
            expectedIdentity: expectedIdentity, expectedAllocationGenerationV1: true,
            expectedPaneReleaseIds: input.pendingPaneReleases.map(\.releaseId),
            expectedWindowReleaseIds: input.pendingWindowReleases.map(\.releaseId)
        )
    }

    func claimPaneLabel(clientId: String, surfaceId: String, paneId: Int64,
                        paneLineageId: String) async throws -> SurfAcePaneAllocation {
        let id = "rq_" + UUID().uuidString.replacingOccurrences(of: "-", with: "")
        try await socket.send(.data(SurfAceRegistrationWire.paneClaimData(
            clientId: clientId, surfaceId: surfaceId, paneId: paneId,
            paneLineageId: paneLineageId, id: id
        )))
        let message = try await socket.receive()
        let data: Data
        switch message {
        case .data(let value): data = value
        case .string(let value): data = Data(value.utf8)
        @unknown default: throw SurfAceRegistrationError.invalidResponse
        }
        return try SurfAceRegistrationWire.paneClaimAllocation(
            from: data, requestId: id, expectedAllocationGenerationV1: true
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
            return try SurfAceRegistrationWire.registryIdentity(from: await receive(), requestId: id)
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
            let response = try await receive()
            return try SurfAceRegistrationWire.assignments(from: response, requestId: id, clientId: clientId,
                                                            surfaces: surfaces, expectedIdentity: expectedIdentity)
        } catch {
            close()
            throw error
        }
    }

    func register(clientId: String, input: SurfAceRegistrationInput,
                  expectedIdentity: SurfAceRegistryIdentity) async throws -> SurfAceRegistrationReply {
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
            return try SurfAceRegistrationWire.registration(
                from: try await receive(), requestId: id, clientId: clientId,
                surfaces: input.surfaces, expectedIdentity: expectedIdentity,
                expectedAllocationGenerationV1: true,
                expectedPaneReleaseIds: input.pendingPaneReleases.map(\.releaseId),
                expectedWindowReleaseIds: input.pendingWindowReleases.map(\.releaseId)
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
            return try SurfAceRegistrationWire.paneClaimAllocation(
                from: await receive(), requestId: id, expectedAllocationGenerationV1: true
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
    ) async throws -> Void
    typealias VerifyRegistry = @MainActor (SurfAceRegistryIdentity, [SurfAceRegistrationSurface]) async throws -> Void
    typealias RecoverRefusedRelease = @MainActor (String) async throws -> Void
    typealias RecoverRefusedClaim = @MainActor (SurfAceRegistrationClaim) async throws -> Void

    private enum RecoveryResult {
        case applied
        case retry(SurfAceRegistrationInput)
    }

    private struct Candidate {
        let url: URL
        let transport: any SurfAceRegistrationTransport
        let phase: String
    }

    private struct IdentifiedCandidate {
        let candidate: Candidate
        let identity: SurfAceRegistryIdentity
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
    ) async throws {
        if let applyReplySubset {
            try await applyReplySubset(reply, input, request)
        } else if let applyReply {
            try await applyReply(reply, input)
        } else {
            try await apply(reply.assignments, input.surfaces)
        }
    }

    private func synchronizeOnce() async throws {
        guard !stopped else { throw SurfAceRegistrationError.stopped }
        if selected == nil { setStatus(.connecting) }
        defer { if status == .connecting { setStatus(.disconnected) } }
        let input = try await currentInputSnapshot()
        guard !input.surfaces.isEmpty || !input.pendingPaneReleases.isEmpty
            || !input.pendingWindowReleases.isEmpty else { return }
        guard !stopped else { throw SurfAceRegistrationError.stopped }

        let failures = FailureCollector()
        var selectedRegistrationFailed = false

        // A healthy selected route is the steady-state path. Reuse its socket
        // and avoid a Bonjour scan and identity connections to other addresses
        // on every timer tick.
        if let selected {
            do {
                let identity = try await selected.transport.readRegistryIdentity()
                guard identity.isValid else { throw SurfAceRegistrationError.registryIdentityMissing }
                guard input.registryIdentity == nil || input.registryIdentity == identity else {
                    throw SurfAceRegistrationError.foreignRegistryIdentity
                }
                try await bindCandidateRegistry(identity, input: input, surfaces: try await snapshot())
                let boundInput = try await currentInputSnapshot()
                guard inputSnapshot == nil || boundInput.registryIdentity == identity else {
                    throw SurfAceRegistrationError.registryBindingPersistencePending
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
                let identity = try await candidate.transport.readRegistryIdentity()
                guard identity.isValid else { throw SurfAceRegistrationError.registryIdentityMissing }
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
        // Keep the current identity while any endpoint for it is discoverable.
        // Otherwise endpoint order chooses the next valid registry, including
        // a registry the client used before its current binding.
        let selectedIdentity = matching?.identity ?? identified.first?.identity

        guard let selectedIdentity else {
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

        for identifiedCandidate in identified where identifiedCandidate.identity == selectedIdentity {
            let candidate = identifiedCandidate.candidate
            if selectedRegistrationFailed, let selected, selected.url == candidate.url { continue }
            do {
                try await bindCandidateRegistry(
                    identifiedCandidate.identity, input: try await currentInputSnapshot(), surfaces: try await snapshot()
                )
                let boundInput = try await currentInputSnapshot()
                guard inputSnapshot == nil || boundInput.registryIdentity == identifiedCandidate.identity else {
                    throw SurfAceRegistrationError.registryBindingPersistencePending
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
            ? "registry registration failed for every endpoint with identity \(selectedIdentity.allocatorId)/\(selectedIdentity.fleetId)"
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
        _ identity: SurfAceRegistryIdentity,
        input: SurfAceRegistrationInput,
        surfaces: [SurfAceRegistrationSurface]
    ) async throws {
        guard let bound = input.registryIdentity else {
            try await bindRegistry(identity, surfaces)
            return
        }
        if bound == identity {
            try await verifyRegistry(identity, surfaces)
        } else {
            try await bindRegistry(identity, surfaces)
        }
    }

    private func registerAndApply(
        using transport: any SurfAceRegistrationTransport,
        identity: SurfAceRegistryIdentity,
        input: SurfAceRegistrationInput
    ) async throws {
        var current = input
        let maximumRecoveryAttempts = 1 + input.pendingPaneReleases.count
            + input.pendingWindowReleases.count
            + input.surfaces.reduce(0) { $0 + 1 + $1.panes.count }
        for _ in 0..<maximumRecoveryAttempts {
            guard !stopped else { throw SurfAceRegistrationError.stopped }
            do {
                let reply = try await transport.register(clientId: clientId, input: current, expectedIdentity: identity)
                try await applyRegistrationReply(reply, input: current, request: current)
                return
            } catch let error as SurfAceRegistrationError {
                guard case .serverRejected = error else {
                    if !current.pendingPaneReleases.isEmpty || !current.pendingWindowReleases.isEmpty {
                        let noReleases = current.withoutReleases
                        do {
                            let reply = try await transport.register(
                                clientId: clientId, input: noReleases, expectedIdentity: identity
                            )
                            try await applyRegistrationReply(reply, input: current, request: noReleases)
                            return
                        } catch {
                            throw error
                        }
                    }
                    throw error
                }

                switch try await recoverSemanticRejection(
                    using: transport, identity: identity, input: current
                ) {
                case .applied:
                    return
                case .retry(let updated):
                    current = updated
                }
            } catch {
                if !current.pendingPaneReleases.isEmpty || !current.pendingWindowReleases.isEmpty {
                    let noReleases = current.withoutReleases
                    let reply = try await transport.register(
                        clientId: clientId, input: noReleases, expectedIdentity: identity
                    )
                    try await applyRegistrationReply(reply, input: current, request: noReleases)
                    return
                }
                throw error
            }
        }
        throw SurfAceRegistrationError.serverRejected(
            code: "registration_recovery_exhausted", message: "registration recovery did not converge"
        )
    }

    private func recoverSemanticRejection(
        using transport: any SurfAceRegistrationTransport,
        identity: SurfAceRegistryIdentity,
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
            } catch {
                // Nothing has proved that an individual saved claim is the cause.
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
                    guard case .serverRejected = probeError,
                          let recoverRefusedClaim else { throw probeError }
                    try await recoverRefusedClaim(.surface(surfaceId: surface.surfaceId))
                    return .retry(try await currentInputSnapshot())
                } catch {
                    // The probe outcome is unknown; retain every claim and try
                    // the complete request once before relying on later retries.
                    let reply = try await transport.register(
                        clientId: clientId, input: withoutReleases, expectedIdentity: identity
                    )
                    try await applyRegistrationReply(reply, input: input, request: withoutReleases)
                    return .applied
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
                        guard case .serverRejected = probeError,
                              let recoverRefusedClaim else { throw probeError }
                        try await recoverRefusedClaim(.pane(
                            surfaceId: surface.surfaceId, paneId: pane.paneId,
                            paneLineageId: pane.paneLineageId
                        ))
                        return .retry(try await currentInputSnapshot())
                    } catch {
                        let reply = try await transport.register(
                            clientId: clientId, input: withoutReleases, expectedIdentity: identity
                        )
                        try await applyRegistrationReply(reply, input: input, request: withoutReleases)
                        return .applied
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
            try await applyRegistrationReply(acceptedSurfaceReply, input: input, request: withoutReleases)
            return .applied
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
                guard case .serverRejected = probeError,
                      let recoverRefusedRelease else { throw probeError }
                try await recoverRefusedRelease(release.releaseId)
                return .retry(try await currentInputSnapshot())
            } catch {
                try await applyRegistrationReply(acceptedSurfaceReply, input: input, request: withoutReleases)
                return .applied
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
                guard case .serverRejected = probeError,
                      let recoverRefusedRelease else { throw probeError }
                try await recoverRefusedRelease(release.releaseId)
                return .retry(try await currentInputSnapshot())
            } catch {
                try await applyRegistrationReply(acceptedSurfaceReply, input: input, request: withoutReleases)
                return .applied
            }
            acceptedPanes.append(release)
        }
        try await applyRegistrationReply(lastReply, input: input, request: input)
        return .applied
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
        try await verifyRegistry(try await transport.readRegistryIdentity(), try await snapshot())
        return try await transport.claimPaneLabel(
            clientId: clientId, surfaceId: surfaceId, paneId: paneId, paneLineageId: paneLineageId
        )
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
            let identity = try await candidate.readRegistryIdentity()
            try await verifyRegistry(identity, input.surfaces)
            let reply = try await candidate.register(
                clientId: clientId, input: input, expectedIdentity: identity
            )
            guard !stopped else { throw SurfAceRegistrationError.stopped }
            try await applyRegistrationReply(reply, input: input, request: input)
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
