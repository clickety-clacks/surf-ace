import CryptoKit
import Foundation
import XCTest
@testable import SurfAce

@MainActor
final class SurfAceCentralRegistrationTests: XCTestCase {
    private final class Transport: SurfAceRegistrationTransport {
        var error: Error?
        var fails = false
        var closed = false
        var clients: [String] = []
        var label = "z"
        func register(clientId: String, surfaces: [SurfAceRegistrationSurface]) async throws -> [SurfAceRegistrationAssignment] {
            clients.append(clientId)
            if let error { throw error }
            if fails { throw SurfAceRegistrationError.noServer }
            return surfaces.map { SurfAceRegistrationAssignment(surfaceId: $0.surfaceId, windowLabel: label) }
        }
        func close() { closed = true }
    }

    func testConfiguredFailureDiscoveryReconnectAndConfiguredRecovery() async throws {
        let configured = URL(string: "ws://configured.invalid:9001/")!
        let discovered = URL(string: "ws://discovered.local:9002/")!
        let primary = Transport()
        primary.fails = true
        let fallback = Transport()
        var attempts: [URL] = []
        var discoveries = 0
        var applied: [String] = []
        let surfaces = [SurfAceRegistrationSurface(surfaceId: "sf_one", panes: [.init(paneId: "1", paneLabel: 1)])]
        let registration = SurfAceCentralRegistration(clientId: String(repeating: "a", count: 64), configured: configured,
            discover: { discoveries += 1; return [discovered] },
            makeTransport: { url in attempts.append(url); return url == configured ? primary : fallback },
            snapshot: { surfaces }, apply: { assignments, _ in applied.append(assignments[0].windowLabel) })
        try await registration.synchronize()
        XCTAssertEqual(attempts, [configured, discovered])
        XCTAssertEqual(discoveries, 1)
        XCTAssertEqual(applied, ["z"])
        primary.fails = false
        primary.label = "y"
        try await registration.synchronize()
        XCTAssertEqual(applied, ["z", "z", "y"])
        XCTAssertTrue(fallback.closed)
        primary.fails = true
        try await registration.synchronize()
        XCTAssertEqual(discoveries, 2)
        XCTAssertEqual(applied.last, "z")
        registration.stop()
        let count = attempts.count
        do { try await registration.synchronize(); XCTFail("stopped registration ran") } catch { }
        XCTAssertEqual(attempts.count, count)
    }

    func testNumericDiscoveryFallbackRequiresHostnameResolutionFailure() async throws {
        let hostname = URL(string: "ws://server.local:9001/")!
        let numeric = URL(string: "ws://192.0.2.1:9001/")!
        for code in [URLError.cannotConnectToHost, URLError.cannotFindHost] {
            let host = Transport()
            host.error = URLError(code)
            let address = Transport()
            var attempts: [URL] = []
            var applied = false
            let registration = SurfAceCentralRegistration(clientId: String(repeating: "b", count: 64), configured: nil,
                discover: { [hostname] },
                makeTransport: { url in attempts.append(url); return url == hostname ? host : address },
                transportFallbacks: { _ in [numeric] },
                snapshot: { [.init(surfaceId: "sf_one", panes: [.init(paneId: "1", paneLabel: 1)])] },
                apply: { _, _ in applied = true })
            do { try await registration.synchronize() } catch {
                XCTAssertEqual(code, .cannotConnectToHost)
            }
            XCTAssertEqual(attempts, code == .cannotFindHost ? [hostname, numeric] : [hostname])
            XCTAssertEqual(applied, code == .cannotFindHost)
            registration.stop()
        }
    }

    func testPersistenceFailureDoesNotPublishAssignmentAndReloadKeepsLabels() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registration-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var initial = try SurfAceLocklessAuthorityState.empty()
        let id = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(state: &initial, expectedSurfaceSetRevision: 0).surface.surfaceId
        let blocker = root.appendingPathComponent("not-a-directory")
        try Data([1]).write(to: blocker)
        let broken = try SurfAceLocklessTransactionCoordinator(state: initial,
            store: .init(stateURL: blocker.appendingPathComponent("state.json")))
        do {
            try await broken.transact { state in
                try SurfAceLocklessTopologyOperations.applyWindowLabels(state: &state, assignments: [(id, "z")])
            }
            XCTFail("persistence failure was ignored")
        } catch { }
        let unchanged = await broken.snapshot()
        XCTAssertEqual(unchanged, initial)
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        let coordinator = try SurfAceLocklessTransactionCoordinator(state: initial, store: store)
        try await coordinator.transact { state in
            try SurfAceLocklessTopologyOperations.applyWindowLabels(state: &state, assignments: [(id, "z")])
        }
        let durable = try XCTUnwrap(store.load())
        XCTAssertEqual(durable.liveSurfaces[id]?.windowLabel, "z")
        XCTAssertEqual(durable.liveSurfaces[id]?.panes, initial.liveSurfaces[id]?.panes)
        let restored = try SurfAceLocklessTransactionCoordinator(store: store)
        let afterRestart = await restored.snapshot()
        XCTAssertEqual(afterRestart, durable)
    }

    func testProductionAllocatorAssignsDistinctLabelsAndRetainsIdentityOnReconnect() async throws {
        guard let address = ProcessInfo.processInfo.environment["SURF_ACE_TEST_ALLOCATOR"],
              let url = URL(string: address) else { throw XCTSkip("isolated allocator not supplied") }
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registration-wire-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        var identities: [SurfAceIdentity] = []
        var states: [SurfAceLocklessAuthorityState] = []
        var labels: [String] = []
        let connections = [SurfAceRegistrationWebSocket(url: url), SurfAceRegistrationWebSocket(url: url)]
        defer { connections.forEach { $0.close() } }
        for index in 0..<2 {
            let key = Curve25519.Signing.PrivateKey()
            try key.rawRepresentation.write(to: root.appendingPathComponent("key-\(index)"), options: .atomic)
            let identity = SurfAceIdentity(privateKey: key, publicKeyRaw: key.publicKey.rawRepresentation, fingerprint: "")
            identities.append(identity)
            var state = try SurfAceLocklessAuthorityState.empty()
            _ = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(state: &state, expectedSurfaceSetRevision: 0)
            let assignments = try await connections[index].register(clientId: identity.clientId, surfaces: SurfAceRegistrationSurface.snapshot(state))
            try SurfAceLocklessTopologyOperations.applyWindowLabels(state: &state, assignments: assignments.map { ($0.surfaceId, $0.windowLabel) })
            let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state-\(index).json"))
            try store.save(state)
            states.append(state)
            labels.append(try XCTUnwrap(assignments.first?.windowLabel))
        }
        XCTAssertNotEqual(identities[0].clientId, identities[1].clientId)
        XCTAssertNotEqual(labels[0], labels[1])
        for index in 0..<2 {
            connections[index].close()
            let restored = try Curve25519.Signing.PrivateKey(rawRepresentation: Data(contentsOf: root.appendingPathComponent("key-\(index)")))
            let identity = SurfAceIdentity(privateKey: restored, publicKeyRaw: restored.publicKey.rawRepresentation, fingerprint: "")
            XCTAssertEqual(identity.clientId, identities[index].clientId)
            let state = try XCTUnwrap(SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state-\(index).json")).load())
            XCTAssertEqual(state, states[index])
            let connection = SurfAceRegistrationWebSocket(url: url)
            defer { connection.close() }
            let assignments = try await connection.register(clientId: identity.clientId, surfaces: SurfAceRegistrationSurface.snapshot(state))
            XCTAssertEqual(assignments.first?.windowLabel, labels[index])
        }
        print("PRODUCTION_REGISTRATION clients=\(identities.map(\.clientId)) labels=\(labels) reconnect=PASS")
    }

    func testIdentityDiagnosticIdentifiesSecurityOperationWithoutErrorContents() {
        for operation in ["SecItemCopyMatching.initial", "SecItemCopyMatching.readback", "SecItemAdd.create"] {
            XCTAssertEqual(SurfAceIdentityStore.failureDiagnostic(
                SurfAceIdentityStoreError.keychain(operation: operation, status: -34018)),
                "operation=\(operation) os_status=-34018")
        }
        XCTAssertEqual(SurfAceIdentityStore.failureDiagnostic(
            SurfAceIdentityStoreError.keychain(operation: "secret-key-material", status: -1)),
            "operation=unknown os_status=-1")
        XCTAssertEqual(SurfAceIdentityStore.failureDiagnostic(NSError(domain: "secret-key-material", code: 99)),
            "operation=identity_initialization result=non_security_error")
    }

    func testIdentityUsesFullSPKIAndSurvivesPrivateKeyReload() throws {
        let bytes = Data(repeating: 7, count: 32)
        let first = try Curve25519.Signing.PrivateKey(rawRepresentation: bytes)
        let restored = try Curve25519.Signing.PrivateKey(rawRepresentation: first.rawRepresentation)
        let a = SurfAceIdentity(privateKey: first, publicKeyRaw: first.publicKey.rawRepresentation, fingerprint: "display")
        let b = SurfAceIdentity(privateKey: restored, publicKeyRaw: restored.publicKey.rawRepresentation, fingerprint: "other")
        XCTAssertEqual(a.clientId, b.clientId)
        XCTAssertEqual(a.clientId.count, 64)
        let expected = SHA256.hash(data: Data([0x30,0x2a,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x03,0x21,0x00]) + first.publicKey.rawRepresentation)
            .map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(a.clientId, expected)
        XCTAssertNotEqual(a.clientId, a.fingerprint)
    }
}
