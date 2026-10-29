import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import SurfAce

@MainActor
final class SurfAceCentralRegistrationTests: XCTestCase {
    func testXCTestHostIsolationFlag() {
        XCTAssertEqual(ProcessInfo.processInfo.environment["SURF_ACE_XCTEST_HOST_NO_AUTOSTART"], "1")
    }

    private final class Transport: SurfAceRegistrationTransport {
        var error: Error?
        var failRegistrationOnce = false
        var fails = false
        var closed = false
        var clients: [String] = []
        var label = "z"
        var assignsPaneLabels = false
        var registeredSurfaces: [SurfAceRegistrationSurface] = []
        var registrationInputs: [SurfAceRegistrationInput] = []
        var nextPaneLabel: Int64 = 700
        var registryIdentity = SurfAceRegistryIdentity(allocatorId: "alloc_fixture", fleetId: "fixture-fleet")
        var identityReads = 0
        var refusedClaim: SurfAceRegistrationClaim?
        var refusedReleaseIds: Set<String> = []
        var unknownReleaseId: String?
        var deliveredUnknownRelease = false
        var acceptedReleaseIds: [String] = []
        var rejectsEveryRegistration = false
        var returnsGenerationV1 = true
        var registrationCount = 0
        var registrationIdentity: SurfAceRegistryIdentity?
        var omitsRegistrationIdentity = false
        var tailnetEndpoint: URL?
        var onIdentityRead: (() -> Void)?
        var onRegister: (() -> Void)?
        var assignedWindowLabels: [String: String] = [:]
        var assignedWindowGenerations: [String: Int64] = [:]
        var assignedPaneLabels: [String: Int64] = [:]
        var assignedPaneGenerations: [String: Int64] = [:]
        var queuedReplies: [SurfAceRegistrationReply] = []
        var nextRegistryIdentityAfterQueuedReply: SurfAceRegistryIdentity?
        var onInputRegister: (@MainActor (SurfAceRegistrationInput) async -> Void)?

        private static func alphabeticLabel(_ value: Int) -> String {
            var number = max(value, 1)
            var result = ""
            while number > 0 {
                number -= 1
                result = String(UnicodeScalar(97 + number % 26)!) + result
                number /= 26
            }
            return result
        }

        func readRegistryIdentity() async throws -> SurfAceRegistryIdentity {
            identityReads += 1
            onIdentityRead?()
            return registryIdentity
        }
        func register(clientId: String, surfaces: [SurfAceRegistrationSurface],
                      expectedIdentity: SurfAceRegistryIdentity) async throws -> [SurfAceRegistrationAssignment] {
            guard registryIdentity == expectedIdentity else { throw SurfAceRegistrationError.invalidResponse }
            clients.append(clientId)
            registeredSurfaces = surfaces
            if let error { throw error }
            if fails { throw SurfAceRegistrationError.noServer }
            return surfaces.map { surface in
                let panes: [SurfAceRegistrationSurface.Pane]
                if assignsPaneLabels {
                    panes = surface.panes.map { pane in
                    defer { nextPaneLabel += 1 }
                    return SurfAceRegistrationSurface.Pane(
                        paneId: pane.paneId, paneLineageId: pane.paneLineageId,
                        paneLabel: nextPaneLabel
                    )
                    }
                } else {
                    panes = []
                }
                return SurfAceRegistrationAssignment(
                    surfaceId: surface.surfaceId, windowLabel: label, panes: panes
                )
            }
        }

        func register(
            clientId: String,
            input: SurfAceRegistrationInput,
            expectedIdentity: SurfAceRegistryIdentity
        ) async throws -> SurfAceRegistrationReply {
            guard registryIdentity == expectedIdentity else { throw SurfAceRegistrationError.invalidResponse }
            registrationCount += 1
            clients.append(clientId)
            registeredSurfaces = input.surfaces
            registrationInputs.append(input)
            onRegister?()
            await onInputRegister?(input)
            if let error { throw error }
            if fails { throw SurfAceRegistrationError.noServer }
            if failRegistrationOnce {
                failRegistrationOnce = false
                throw URLError(.networkConnectionLost)
            }
            if rejectsEveryRegistration {
                throw SurfAceRegistrationError.serverRejected(code: "registry_inactive", message: "retry")
            }
            if !queuedReplies.isEmpty {
                let reply = queuedReplies.removeFirst()
                if let nextRegistryIdentityAfterQueuedReply {
                    registryIdentity = nextRegistryIdentityAfterQueuedReply
                    self.nextRegistryIdentityAfterQueuedReply = nil
                }
                return reply
            }
            if let refusedClaim, claim(refusedClaim, appearsIn: input.surfaces) {
                throw SurfAceRegistrationError.serverRejected(code: "claim_refused", message: "claim")
            }
            let releaseIds = input.pendingWindowReleases.map(\.releaseId)
                + input.pendingPaneReleases.map(\.releaseId)
            if let unknownReleaseId, releaseIds.contains(unknownReleaseId), !deliveredUnknownRelease {
                deliveredUnknownRelease = true
                throw URLError(.networkConnectionLost)
            }
            if releaseIds.contains(where: refusedReleaseIds.contains) {
                throw SurfAceRegistrationError.serverRejected(code: "release_refused", message: "release")
            }
            acceptedReleaseIds.append(contentsOf: releaseIds)

            var usedWindowLabels = Set(assignedWindowLabels.values)
            let assignments = input.surfaces.enumerated().map { index, surface in
                let label: String
                if let assigned = assignedWindowLabels[surface.surfaceId] {
                    label = assigned
                } else {
                    var ordinal = 1
                    while usedWindowLabels.contains(Self.alphabeticLabel(ordinal)) { ordinal += 1 }
                    label = Self.alphabeticLabel(ordinal)
                }
                assignedWindowLabels[surface.surfaceId] = label
                usedWindowLabels.insert(label)
                let panes = surface.panes.map { pane in
                    let key = "\(surface.surfaceId):\(pane.paneId):\(pane.paneLineageId)"
                    let paneLabel: Int64
                    if let assigned = assignedPaneLabels[key] {
                        paneLabel = assigned
                    } else {
                        paneLabel = nextPaneLabel
                        assignedPaneLabels[key] = paneLabel
                        nextPaneLabel += 1
                    }
                    let paneGeneration = assignedPaneGenerations[key] ?? paneLabel + 100
                    assignedPaneGenerations[key] = paneGeneration
                    return SurfAceRegistrationSurface.Pane(
                        paneId: pane.paneId,
                        paneLineageId: pane.paneLineageId,
                        paneLabel: paneLabel,
                        allocationGeneration: returnsGenerationV1 ? paneGeneration : nil
                    )
                }
                let windowGeneration = assignedWindowGenerations[surface.surfaceId] ?? Int64(index + 30)
                assignedWindowGenerations[surface.surfaceId] = windowGeneration
                return SurfAceRegistrationAssignment(
                    surfaceId: surface.surfaceId,
                    windowLabel: label,
                    windowAllocationGeneration: returnsGenerationV1 ? windowGeneration : nil,
                    panes: panes
                )
            }
            return SurfAceRegistrationReply(
                assignments: assignments,
                projection: SurfAceRegistrationProjection(
                    directEndpoint: nil,
                    prePairDescribeV1: false,
                    allocationGenerationV1: returnsGenerationV1,
                    endpointLease: nil,
                    completedPaneReleaseIds: input.pendingPaneReleases.map(\.releaseId),
                    completedWindowReleaseIds: input.pendingWindowReleases.map(\.releaseId)
                ),
                registryIdentity: registrationIdentity ?? registryIdentity,
                reportedRegistryIdentity: omitsRegistrationIdentity ? nil : registrationIdentity ?? registryIdentity,
                tailnetEndpoint: tailnetEndpoint
            )
        }

        func claimPaneLabel(
            clientId: String,
            surfaceId: String,
            paneId: Int64,
            paneLineageId: String
        ) async throws -> SurfAcePaneAllocation {
            let key = "\(surfaceId):\(paneId):\(paneLineageId)"
            let paneLabel: Int64
            if let assigned = assignedPaneLabels[key] {
                paneLabel = assigned
            } else {
                paneLabel = nextPaneLabel
                assignedPaneLabels[key] = paneLabel
                nextPaneLabel += 1
            }
            let generation = assignedPaneGenerations[key] ?? paneLabel + 100
            assignedPaneGenerations[key] = generation
            return SurfAcePaneAllocation(
                paneLabel: paneLabel,
                allocationGeneration: returnsGenerationV1 ? generation : nil
            )
        }

        private func claim(_ claim: SurfAceRegistrationClaim, appearsIn surfaces: [SurfAceRegistrationSurface]) -> Bool {
            switch claim {
            case .surface(let surfaceId):
                return surfaces.contains { $0.surfaceId == surfaceId }
            case .pane(let surfaceId, let paneId, let paneLineageId):
                return surfaces.contains { surface in
                    surface.surfaceId == surfaceId && surface.panes.contains {
                        $0.paneId == paneId && $0.paneLineageId == paneLineageId
                    }
                }
            }
        }

        func close() { closed = true }
    }

    private final class DiscoveryBrowser: NetServiceBrowser {
        var started = false
        var stops = 0

        override func searchForServices(ofType type: String, inDomain domain: String) { started = true }
        override func stop() { stops += 1 }
    }

    private final class DiscoveryService: NetService {
        var resolveTimeout: TimeInterval?
        var stopped = false
        var resolvedHost = "example.test."
        var resolvedPath = "/ws"
        var resolvedVersion = "1"
        var resolvedRole = "server"
        var resolvedAddresses: [Data] = []

        override var hostName: String? { resolvedHost }
        override var addresses: [Data]? { resolvedAddresses }
        override func txtRecordData() -> Data? {
            NetService.data(fromTXTRecord: [
                "role": Data(resolvedRole.utf8),
                "v": Data(resolvedVersion.utf8),
                "ws": Data(resolvedPath.utf8),
            ])
        }
        override func resolve(withTimeout timeout: TimeInterval) { resolveTimeout = timeout }
        override func stop() { stopped = true }
    }

    @MainActor
    private final class DiscoveryClock {
        var calls = 0
        var permits = 0

        func sleep(_ duration: Duration) async throws {
            calls += 1
            while permits == 0 {
                try Task.checkCancellation()
                await Task.yield()
            }
            permits -= 1
        }
    }

    private func discoveryService(name: String = "owned", host: String = "example.test.") -> DiscoveryService {
        let service = DiscoveryService(domain: "local.", type: "_surf-ace._tcp.", name: name, port: 43867)
        service.resolvedHost = host
        return service
    }

    private func until(_ ready: () -> Bool) async {
        for _ in 0..<10_000 {
            if ready() { return }
            await Task.yield()
        }
        XCTFail("expected discovery callback checkpoint")
    }

    private func centralRegistration(
        adapter: SurfAceLocklessRuntimeAdapter,
        clientId: String,
        configured: URL?,
        discovered: [URL],
        transports: [URL: Transport],
        discoverOverride: (@MainActor () async -> [URL])? = nil,
        bindRegistryOverride: (@MainActor (SurfAceRegistryIdentity, [SurfAceRegistrationSurface]) async throws -> Void)? = nil
    ) -> SurfAceCentralRegistration {
        SurfAceCentralRegistration(
            clientId: clientId,
            configured: configured,
            discover: discoverOverride ?? { discovered },
            makeTransport: { transports[$0] ?? Transport() },
            snapshot: { SurfAceRegistrationSurface.snapshot(await adapter.snapshot()) },
            apply: { _, _ in },
            verifyRegistry: { identity, surfaces in
                _ = try await adapter.bindRegistryIdentity(
                    identity, clientId: clientId, expectedSurfaces: surfaces, allowRebinding: false
                )
            },
            bindRegistry: bindRegistryOverride ?? { identity, surfaces in
                _ = try await adapter.bindRegistryIdentity(
                    identity, clientId: clientId, expectedSurfaces: surfaces, allowRebinding: true
                )
            },
            inputSnapshot: { try SurfAceRegistrationInput(state: await adapter.snapshot(), clientId: clientId) },
            applyReplySubset: { reply, expected, request in
                let application = try await adapter.applyRegistration(
                    reply, expectedInput: expected, requestInput: request, clientId: clientId
                )
                return application.needsRetry
            },
            recoverRefusedRelease: { releaseId in
                try await adapter.dropRefusedRelease(releaseId: releaseId)
            },
            recoverRefusedClaim: { claim in
                _ = try await adapter.rotateRefusedClaim(claim)
            },
            rememberTailnetEndpoint: { endpoint, identity in
                try await adapter.rememberTailnetEndpoint(
                    endpoint.absoluteString, registryIdentity: identity, clientId: clientId
                )
            }
        )
    }

    private func boundAdapter(
        at root: URL,
        clientId: String,
        identity: SurfAceRegistryIdentity,
        rememberedEndpoint: String? = nil
    ) async throws -> (SurfAceLocklessGenerationStore, SurfAceLocklessRuntimeAdapter) {
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        try store.save(SurfAceLocklessAuthorityState.empty())
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        _ = try await adapter.bindRegistryIdentity(
            identity, clientId: clientId, expectedSurfaces: [], allowRebinding: true
        )
        if let rememberedEndpoint {
            _ = try await adapter.rememberTailnetEndpoint(
                rememberedEndpoint, registryIdentity: identity, clientId: clientId
            )
        }
        return (store, adapter)
    }

    private func addSavedSurface(
        to state: inout SurfAceLocklessAuthorityState,
        windowLabel: String,
        paneLabel: Int64
    ) throws -> String {
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: state.surfaceSetRevision
        ).surface.surfaceId
        try SurfAceLocklessTopologyOperations.applyWindowLabels(
            state: &state, assignments: [(surfaceId: surfaceId, windowLabel: windowLabel)]
        )
        var surface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        surface.allocationGeneration = 30
        var pane = try XCTUnwrap(surface.panes["1"])
        pane.paneLabel = paneLabel
        pane.allocationGeneration = paneLabel + 100
        pane.history.visible.contentId = "content-\(surfaceId)"
        pane.history.visible.contentType = "html"
        pane.history.visible.content = .object([
            "html": .string("<h1>retained \(surfaceId)</h1>"),
            "paneId": .integer(999),
            "nested": .object(["surfaceId": .string("content-metadata")]),
        ])
        pane.history.visible.revision = 3
        pane.target = .object([
            "paneId": .integer(999),
            "surfaceId": .string("target-metadata"),
            "nested": .object(["paneLineageId": .string("user-data")]),
        ])
        surface.panes["1"] = pane
        state.liveSurfaces[surfaceId] = surface
        return surfaceId
    }

    func testDiscoveryLifecycleWaitsForTerminalResolutionOrBoundedTimeout() {
        let completedBeforeBrowseEnd = NSObject()
        let lateFound = NSObject()
        let failed = NSObject()
        let timedOut = NSObject()

        let lifecycle = SurfAceCentralDiscoveryLifecycle()
        let generation = lifecycle.beginBrowsing()
        XCTAssertTrue(lifecycle.found(completedBeforeBrowseEnd, generation: generation))
        XCTAssertTrue(lifecycle.resolutionSucceeded(completedBeforeBrowseEnd, generation: generation))
        XCTAssertFalse(lifecycle.isComplete(generation: generation))

        XCTAssertTrue(lifecycle.found(lateFound, generation: generation))
        XCTAssertTrue(lifecycle.found(failed, generation: generation))
        XCTAssertTrue(lifecycle.found(timedOut, generation: generation))
        lifecycle.endBrowsing(generation: generation)
        XCTAssertFalse(lifecycle.found(NSObject(), generation: generation))
        XCTAssertFalse(lifecycle.isComplete(generation: generation))

        XCTAssertTrue(lifecycle.resolutionSucceeded(lateFound, generation: generation))
        XCTAssertTrue(lifecycle.resolutionFailed(failed, generation: generation))
        XCTAssertFalse(lifecycle.isComplete(generation: generation))

        lifecycle.resolutionTimedOut(generation: generation)
        XCTAssertTrue(lifecycle.isComplete(generation: generation))
        XCTAssertFalse(lifecycle.resolutionSucceeded(timedOut, generation: generation))
        XCTAssertEqual(lifecycle.pendingCount, 0)
    }

    func testDiscoveryLifecycleWaiterResumesOnLastTerminalResolution() async {
        let service = NSObject()
        let lifecycle = SurfAceCentralDiscoveryLifecycle()
        let generation = lifecycle.beginBrowsing()
        XCTAssertTrue(lifecycle.found(service, generation: generation))
        lifecycle.endBrowsing(generation: generation)

        let waiter = Task { await lifecycle.waitUntilComplete(generation: generation) }
        await Task.yield()
        XCTAssertTrue(lifecycle.resolutionSucceeded(service, generation: generation))
        XCTAssertFalse(lifecycle.resolutionSucceeded(service, generation: generation))
        await waiter.value

        XCTAssertTrue(lifecycle.isComplete(generation: generation))
    }

    func testDiscoveryRejectsServiceFoundAfterIntakeCloses() async {
        let browser = DiscoveryBrowser(), clock = DiscoveryClock()
        let discovery = SurfAceCentralDiscovery(makeBrowser: { browser }, sleep: { try await clock.sleep($0) })
        let result = Task { await discovery.discover() }
        await until { browser.started }
        clock.permits += 1
        await until { browser.stops == 1 }

        let late = discoveryService()
        discovery.netServiceBrowser(browser, didFind: late, moreComing: false)

        XCTAssertNil(late.resolveTimeout)
        XCTAssertTrue(late.stopped)
        let urls = await result.value
        XCTAssertTrue(urls.isEmpty)
    }

    func testDiscoveryIgnoresTerminalCallbacksAfterTimeoutAndCancellation() async {
        let firstBrowser = DiscoveryBrowser(), secondBrowser = DiscoveryBrowser(), clock = DiscoveryClock()
        var browsers = [firstBrowser, secondBrowser]
        let discovery = SurfAceCentralDiscovery(makeBrowser: { browsers.removeFirst() }, sleep: { try await clock.sleep($0) })

        let timedOutService = discoveryService(name: "timed-out")
        let timedOut = Task { await discovery.discover() }
        await until { firstBrowser.started }
        discovery.netServiceBrowser(firstBrowser, didFind: timedOutService, moreComing: false)
        clock.permits += 1
        await until { clock.calls == 2 }
        clock.permits += 1
        let timedOutURLs = await timedOut.value
        XCTAssertTrue(timedOutURLs.isEmpty)
        discovery.netServiceDidResolveAddress(timedOutService)
        discovery.netService(timedOutService, didNotResolve: [:])
        XCTAssertTrue(discovery.transportURLs(for: URL(string: "ws://example.test:43867/")!).isEmpty)

        let cancelledService = discoveryService(name: "cancelled")
        let cancelled = Task { await discovery.discover() }
        await until { secondBrowser.started }
        discovery.netServiceBrowser(secondBrowser, didFind: cancelledService, moreComing: false)
        cancelled.cancel()
        let cancelledURLs = await cancelled.value
        XCTAssertTrue(cancelledURLs.isEmpty)
        discovery.netServiceDidResolveAddress(cancelledService)
        discovery.netService(cancelledService, didNotResolve: [:])
        XCTAssertTrue(discovery.transportURLs(for: URL(string: "ws://example.test:43867/")!).isEmpty)
    }

    func testDiscoveryRejectsStaleTerminalCallbackDuringNextGeneration() async {
        let firstBrowser = DiscoveryBrowser(), secondBrowser = DiscoveryBrowser(), clock = DiscoveryClock()
        var browsers = [firstBrowser, secondBrowser]
        let discovery = SurfAceCentralDiscovery(makeBrowser: { browsers.removeFirst() }, sleep: { try await clock.sleep($0) })

        let stale = discoveryService(name: "stale", host: "stale.local.")
        let first = Task { await discovery.discover() }
        await until { firstBrowser.started }
        discovery.netServiceBrowser(firstBrowser, didFind: stale, moreComing: false)
        clock.permits += 1
        await until { clock.calls == 2 }
        clock.permits += 1
        let firstURLs = await first.value
        XCTAssertTrue(firstURLs.isEmpty)

        let current = discoveryService(name: "current")
        let staleFound = discoveryService(name: "stale-found")
        let second = Task { await discovery.discover() }
        await until { secondBrowser.started }
        discovery.netServiceDidResolveAddress(stale)
        discovery.netService(stale, didNotResolve: [:])
        discovery.netServiceBrowser(firstBrowser, didFind: staleFound, moreComing: false)
        XCTAssertNil(staleFound.resolveTimeout)
        XCTAssertTrue(staleFound.stopped)
        discovery.netServiceBrowser(secondBrowser, didFind: current, moreComing: false)
        clock.permits += 1
        await until { clock.calls == 4 }
        discovery.netServiceDidResolveAddress(current)

        let secondURLs = await second.value
        XCTAssertEqual(secondURLs, [URL(string: "ws://example.test:43867/ws")!])
        discovery.netServiceDidResolveAddress(current)
        XCTAssertTrue(current.stopped)
    }

    func testDiscoveredLocalHostNormalizationMatchesConfiguredHostnameURL() throws {
        let discovered = try XCTUnwrap(
            SurfAceCentralDiscovery.localTransportURL(host: "example.test.", port: 43867, path: "/ws")
        )
        XCTAssertEqual(discovered, URL(string: "ws://example.test:43867/ws"))

        let discoveredLocal = try XCTUnwrap(
            SurfAceCentralDiscovery.localTransportURL(host: "server.local.", port: 43867, path: "/socket")
        )
        XCTAssertEqual(discoveredLocal, URL(string: "ws://server.local:43867/socket"))
    }

    func testDiscoveryRequiresExactServerVersionAndWebSocketPath() async {
        for (name, version, path) in [("wrong-path", "1", "/"), ("wrong-version", "2", "/ws")] {
            let browser = DiscoveryBrowser(), clock = DiscoveryClock()
            let discovery = SurfAceCentralDiscovery(makeBrowser: { browser }, sleep: { try await clock.sleep($0) })
            let invalid = discoveryService(name: name)
            invalid.resolvedVersion = version
            invalid.resolvedPath = path
            let result = Task { await discovery.discover() }
            await until { browser.started }
            discovery.netServiceBrowser(browser, didFind: invalid, moreComing: false)
            discovery.netServiceDidResolveAddress(invalid)
            clock.permits += 1

            let urls = await result.value
            XCTAssertTrue(urls.isEmpty)
            XCTAssertTrue(discovery.lastError?.contains("expected role=server v=1 ws=/ws") == true)
        }
    }

    func testDiscoveryRejectsWildcardSrvTargetsAsClientDestinations() async {
        let browser = DiscoveryBrowser(), clock = DiscoveryClock()
        let discovery = SurfAceCentralDiscovery(makeBrowser: { browser }, sleep: { try await clock.sleep($0) })
        let wildcard = discoveryService(name: "wildcard", host: "0.0.0.0.")
        let result = Task { await discovery.discover() }
        await until { browser.started }
        discovery.netServiceBrowser(browser, didFind: wildcard, moreComing: false)
        discovery.netServiceDidResolveAddress(wildcard)
        clock.permits += 1

        let urls = await result.value
        XCTAssertTrue(urls.isEmpty)
        XCTAssertTrue(discovery.lastError?.contains("wildcard address, not a client destination") == true)
    }

    func testDiscoveryRetainsBrowseFailureDetails() async {
        let browser = DiscoveryBrowser(), clock = DiscoveryClock()
        let discovery = SurfAceCentralDiscovery(makeBrowser: { browser }, sleep: { try await clock.sleep($0) })
        let result = Task { await discovery.discover() }
        await until { browser.started }
        discovery.netServiceBrowser(browser, didNotSearch: [NetService.errorCode: NSNumber(value: -65563)])
        clock.permits += 1

        let urls = await result.value
        XCTAssertTrue(urls.isEmpty)
        XCTAssertTrue(discovery.lastError?.contains("Bonjour browse failed") == true)
        XCTAssertTrue(discovery.lastError?.contains("-65563") == true)
    }

    func testDiscoveryRetainsSrvTargetPortAndDnsSdTransportAddressAfterTargetResolutionFailure() async throws {
        let browser = DiscoveryBrowser(), clock = DiscoveryClock()
        let discovery = SurfAceCentralDiscovery(makeBrowser: { browser }, sleep: { try await clock.sleep($0) })
        let service = discoveryService(name: "target-unresolved", host: "registry.local.")
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(43867).bigEndian
        XCTAssertEqual("192.0.2.15".withCString { inet_pton(AF_INET, $0, &address.sin_addr) }, 1)
        service.resolvedAddresses = withUnsafeBytes(of: &address) { [Data($0)] }

        let result = Task { await discovery.discover() }
        await until { browser.started }
        discovery.netServiceBrowser(browser, didFind: service, moreComing: false)
        discovery.netService(service, didNotResolve: [NetService.errorCode: NSNumber(value: -2)])
        clock.permits += 1

        let target = try XCTUnwrap(URL(string: "ws://registry.local:43867/ws"))
        let urls = await result.value
        XCTAssertEqual(urls, [target])
        XCTAssertEqual(discovery.transportURLs(for: target), [URL(string: "ws://192.0.2.15:43867/ws")!])
        XCTAssertTrue(discovery.lastError?.contains("could not resolve SRV target") == true)
    }

    func testConfiguredLocalNumericEndpointUsesNarrowTransportPolicy() throws {
        let local = try XCTUnwrap(URL(string: "ws://100.64.12.34:43867/"))
        let remote = try XCTUnwrap(URL(string: "ws://203.0.113.9:43867/"))
        let hostname = try XCTUnwrap(URL(string: "ws://example.test:43867/"))
        let secure = try XCTUnwrap(URL(string: "wss://192.168.1.9:43867/"))

        XCTAssertTrue(SurfAceRegistrationEndpoint.usesLocalNumericTransport(local))
        XCTAssertFalse(SurfAceRegistrationEndpoint.usesLocalNumericTransport(remote))
        XCTAssertFalse(SurfAceRegistrationEndpoint.usesLocalNumericTransport(hostname))
        XCTAssertFalse(SurfAceRegistrationEndpoint.usesLocalNumericTransport(secure))

        let localTransport = SurfAceRegistrationTransportFactory.make(url: local)
        let remoteTransport = SurfAceRegistrationTransportFactory.make(url: remote)
        let hostnameTransport = SurfAceRegistrationTransportFactory.make(url: hostname)
        let secureTransport = SurfAceRegistrationTransportFactory.make(url: secure)
        XCTAssertTrue(localTransport is SurfAceLocalNumericRegistrationWebSocket)
        XCTAssertTrue(remoteTransport is SurfAceRegistrationWebSocket)
        XCTAssertTrue(hostnameTransport is SurfAceRegistrationWebSocket)
        XCTAssertTrue(secureTransport is SurfAceRegistrationWebSocket)
        localTransport.close()
        remoteTransport.close()
        hostnameTransport.close()
        secureTransport.close()
    }

    func testVerifiedEndpointWaitsForDiscoveryIdentityAndDurableApplyThenReconcilesReconnect() async throws {
        let homeURL = try XCTUnwrap(URL(string: "ws://127.0.0.1:29990/ws"))
        let nextURL = try XCTUnwrap(URL(string: "ws://127.0.0.1:29991/ws"))
        let foreignURL = try XCTUnwrap(URL(string: "ws://127.0.0.1:29992/ws"))
        let home = Transport()
        let next = Transport()
        let foreign = Transport()
        foreign.registryIdentity = .init(allocatorId: "alloc_foreign", fleetId: "foreign")
        var discovered: [URL] = []
        var failPersistence = false
        var selected: [URL] = []
        var applied = 0
        let registration = SurfAceCentralRegistration(
            clientId: "stable-client", configured: nil,
            discover: { discovered },
            makeTransport: { $0 == homeURL ? home : ($0 == nextURL ? next : foreign) },
            snapshot: { [.init(surfaceId: "sf_one", panes: [])] },
            apply: { _, _ in
                if failPersistence { throw SurfAceRegistrationError.registryBindingPersistencePending }
                applied += 1
            },
            verifyRegistry: { identity, _ in
                guard identity == home.registryIdentity else { throw SurfAceRegistrationError.foreignRegistryIdentity }
            },
            onVerifiedEndpoint: { endpoint in
                XCTAssertGreaterThan(applied, selected.count, "selection follows durable label application")
                selected.append(endpoint)
            }
        )
        defer { registration.stop() }
        do { try await registration.synchronize(); XCTFail("discovery not available") } catch {}
        XCTAssertTrue(selected.isEmpty)
        discovered = [foreignURL]
        do { try await registration.synchronize(); XCTFail("foreign registry") } catch {}
        XCTAssertTrue(selected.isEmpty)
        XCTAssertTrue(foreign.clients.isEmpty)
        discovered = [homeURL]
        failPersistence = true
        do { try await registration.synchronize(); XCTFail("unpersisted registration") } catch {}
        XCTAssertTrue(selected.isEmpty)
        failPersistence = false
        try await registration.synchronize()
        try await registration.synchronize()
        XCTAssertEqual(selected, [homeURL, homeURL])
        home.fails = true
        discovered = [nextURL]
        try await registration.synchronize()
        XCTAssertEqual(selected, [homeURL, homeURL, nextURL])
        XCTAssertEqual(next.clients, ["stable-client"])
    }

    func testConfiguredLocalNumericSuccessRemainsPinnedWhenDiscoveryReturnsNoCandidates() async throws {
        let configured = try XCTUnwrap(URL(string: "ws://100.64.12.34:43867/"))
        let transport = Transport()
        var attempted: [URL] = []
        let registration = SurfAceCentralRegistration(
            clientId: "numeric-client",
            configured: configured,
            discover: { [] },
            makeTransport: { url in attempted.append(url); return transport },
            snapshot: { [.init(surfaceId: "sf_one", panes: [])] },
            apply: { _, _ in }, verifyRegistry: { _, _ in }
        )

        try await registration.synchronize()
        XCTAssertEqual(attempted, [configured])
        XCTAssertEqual(registration.status, .connected)
        registration.stop()
    }

    func testConfiguredLocalNumericFailureUsesBonjourFallbackAndRetriesConfigured() async throws {
        let configured = try XCTUnwrap(URL(string: "ws://100.64.12.34:43867/"))
        let discovered = try XCTUnwrap(URL(string: "ws://example.test:43867/"))
        let primary = Transport()
        primary.fails = true
        primary.assignedWindowLabels["sf_one"] = "configured"
        let fallback = Transport()
        fallback.assignedWindowLabels["sf_one"] = "bonjour"
        var attempted: [URL] = []
        var applied: [String] = []
        var discoveredCalled = false
        let registration = SurfAceCentralRegistration(
            clientId: "numeric-client",
            configured: configured,
            discover: { discoveredCalled = true; return [discovered] },
            makeTransport: { url in
                attempted.append(url)
                return url == configured ? primary : fallback
            },
            snapshot: { [.init(surfaceId: "sf_one", panes: [])] },
            apply: { assignments, _ in applied.append(assignments[0].windowLabel) },
            verifyRegistry: { _, _ in }
        )

        try await registration.synchronize()
        XCTAssertEqual(attempted, [configured, discovered])
        XCTAssertTrue(discoveredCalled)
        XCTAssertEqual(applied, ["bonjour"])
        XCTAssertEqual(registration.status, .connected)

        primary.fails = false
        try await registration.synchronize()
        XCTAssertEqual(attempted, [configured, discovered])
        XCTAssertEqual(applied, ["bonjour", "bonjour"])
        XCTAssertEqual(registration.status, .connected)

        fallback.fails = true
        try await registration.synchronize()
        XCTAssertEqual(attempted, [configured, discovered, configured])
        XCTAssertEqual(applied, ["bonjour", "bonjour", "configured"])
        XCTAssertEqual(registration.status, .connected)
        registration.stop()
    }

    func testConfiguredSecureRemoteURLIsNotNormalizedByDiscovery() async throws {
        let configured = try XCTUnwrap(URL(string: "wss://central.example.com:9443/secure"))
        let transport = Transport()
        var attempted: [URL] = []
        let registration = SurfAceCentralRegistration(clientId: "test", configured: configured,
            discover: { [] },
            makeTransport: { url in attempted.append(url); return transport },
            snapshot: { [.init(surfaceId: "sf_one", panes: [])] }, apply: { _, _ in },
            verifyRegistry: { _, _ in })

        try await registration.synchronize()
        XCTAssertEqual(attempted, [configured])
        registration.stop()
    }


    func testCentralStatusTracksRegistrationPersistenceLossRetryAndStop() async throws {
        let transport = Transport()
        let url = URL(string: "ws://configured.invalid:9001/")!
        var statuses: [SurfAceCentralRegistrationStatus] = []
        var persisted = false
        let registration = SurfAceCentralRegistration(clientId: "real-test-identity", configured: url,
            discover: { [] }, makeTransport: { _ in transport },
            snapshot: { [.init(surfaceId: "sf_one", panes: [.init(paneId: "1", paneLineageId: "lineage_one", paneLabel: 1)])] },
            apply: { _, _ in
                XCTAssertNotEqual(statuses.last, .connected)
                persisted = true
            }, verifyRegistry: { _, _ in }, onStatusChange: { state in
                if state == .connected { XCTAssertTrue(persisted) }
                statuses.append(state)
            })
        XCTAssertEqual(registration.status, .disconnected)
        try await registration.synchronize()
        XCTAssertEqual(statuses, [.connecting, .connected])
        transport.fails = true
        do { try await registration.synchronize(); XCTFail("loss succeeded") } catch { }
        XCTAssertEqual(registration.status, .disconnected)
        transport.fails = false
        persisted = false
        try await registration.synchronize()
        XCTAssertEqual(Array(statuses.suffix(2)), [.connecting, .connected])
        registration.stop()
        XCTAssertEqual(registration.status, .disconnected)
        let count = statuses.count
        do { try await registration.synchronize(); XCTFail("stopped registration succeeded") } catch { }
        XCTAssertEqual(statuses.count, count)
    }

    func testCentralStatusDoesNotConnectOnPersistenceFailureOrAfterStopDuringApply() async throws {
        for stopDuringApply in [false, true] {
            let transport = Transport()
            var statuses: [SurfAceCentralRegistrationStatus] = []
            var registration: SurfAceCentralRegistration!
            registration = SurfAceCentralRegistration(clientId: "test", configured: URL(string: "ws://configured.invalid/")!,
                discover: { [] }, makeTransport: { _ in transport },
                snapshot: { [.init(surfaceId: "sf_one", panes: [])] },
                apply: { _, _ in
                    if stopDuringApply { registration.stop() }
                    else { throw SurfAceRegistrationError.topologyChanged }
                }, verifyRegistry: { _, _ in }, onStatusChange: { statuses.append($0) })
            do { try await registration.synchronize(); XCTFail("uncommitted registration succeeded") } catch { }
            XCTAssertFalse(statuses.contains(.connected))
            XCTAssertEqual(registration.status, .disconnected)
            registration.stop()
        }
    }

    func testHealthyDiscoveryConnectionStaysConnectedWhilePreferredServerIsUnavailable() async throws {
        let fallback = Transport()
        let primary = Transport(); primary.fails = true
        let configured = URL(string: "ws://configured.invalid/")!
        let discovered = URL(string: "ws://discovered.invalid/")!
        var statuses: [SurfAceCentralRegistrationStatus] = []
        let registration = SurfAceCentralRegistration(clientId: "test", configured: configured,
            discover: { [discovered] }, makeTransport: { $0 == configured ? primary : fallback },
            snapshot: { [.init(surfaceId: "sf_one", panes: [])] }, apply: { _, _ in },
            verifyRegistry: { _, _ in },
            onStatusChange: { statuses.append($0) })
        try await registration.synchronize()
        XCTAssertEqual(registration.status, .connected)
        let count = statuses.count
        let primaryIdentityReads = primary.identityReads
        let fallbackIdentityReads = fallback.identityReads
        try await registration.synchronize()
        XCTAssertEqual(registration.status, .connected)
        XCTAssertEqual(statuses.count, count)
        XCTAssertEqual(primary.identityReads, primaryIdentityReads)
        XCTAssertEqual(fallback.identityReads, fallbackIdentityReads + 1)
        registration.stop()
    }

    func testStopDuringSnapshotDoesNotRestartDiscoveryOrStatus() async throws {
        var statuses: [SurfAceCentralRegistrationStatus] = []
        var registration: SurfAceCentralRegistration!
        registration = SurfAceCentralRegistration(clientId: "test", configured: nil,
            discover: { XCTFail("discovery after stop"); return [] },
            snapshot: {
                registration.stop()
                return [.init(surfaceId: "sf_one", panes: [])]
            }, apply: { _, _ in XCTFail("apply after stop") }, verifyRegistry: { _, _ in },
            onStatusChange: { statuses.append($0) })
        do { try await registration.synchronize(); XCTFail("stopped snapshot succeeded") } catch { }
        XCTAssertEqual(statuses, [.connecting, .disconnected])
    }

    func testEmptyStartupPublishesConnectedAfterRegistryBind() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-empty-startup-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        try store.save(SurfAceLocklessAuthorityState.empty())
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let clientId = String(repeating: "e", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_empty", fleetId: "empty-fleet")
        let endpoint = URL(string: "ws://127.0.0.1:24030/ws")!
        let transport = Transport()
        transport.registryIdentity = identity
        var statuses: [SurfAceCentralRegistrationStatus] = []
        let registration = SurfAceCentralRegistration(clientId: clientId, configured: endpoint,
            discover: { [] }, makeTransport: { _ in transport },
            snapshot: { [] },
            apply: { _, _ in },
            verifyRegistry: { identity, surfaces in
                _ = try await adapter.bindRegistryIdentity(
                    identity, clientId: clientId, expectedSurfaces: surfaces, allowRebinding: false
                )
            },
            bindRegistry: { identity, surfaces in
                _ = try await adapter.bindRegistryIdentity(
                    identity, clientId: clientId, expectedSurfaces: surfaces, allowRebinding: true
                )
            },
            inputSnapshot: {
                try SurfAceRegistrationInput(state: await adapter.snapshot(), clientId: clientId)
            },
            applyReplySubset: { reply, expected, request in
                let application = try await adapter.applyRegistration(
                    reply, expectedInput: expected, requestInput: request, clientId: clientId
                )
                return application.needsRetry
            },
            onStatusChange: { statuses.append($0) })
        try await registration.synchronize()
        XCTAssertEqual(registration.status, .connected)
        XCTAssertTrue(statuses.contains(.connected))
        XCTAssertEqual((try store.load())?.registryBinding, .init(
            allocatorId: identity.allocatorId, clientId: clientId, fleetId: identity.fleetId
        ))
        XCTAssertTrue(transport.registrationInputs.last?.surfaces.isEmpty == true)
        registration.stop()
    }

    func testConfiguredFailureDiscoveryReconnectAndConfiguredRecovery() async throws {
        let configured = URL(string: "ws://configured.invalid:9001/")!
        let discovered = URL(string: "ws://discovered.local:9002/")!
        let primary = Transport()
        primary.fails = true
        let fallback = Transport()
        primary.assignedWindowLabels["sf_one"] = "y"
        fallback.assignedWindowLabels["sf_one"] = "z"
        var attempts: [URL] = []
        var discoveries = 0
        var applied: [String] = []
        let surfaces = [SurfAceRegistrationSurface(surfaceId: "sf_one", panes: [.init(paneId: "1", paneLineageId: "lineage_one", paneLabel: 1)])]
        let registration = SurfAceCentralRegistration(clientId: String(repeating: "a", count: 64), configured: configured,
            discover: { discoveries += 1; return [discovered] },
            makeTransport: { url in attempts.append(url); return url == configured ? primary : fallback },
            snapshot: { surfaces }, apply: { assignments, _ in applied.append(assignments[0].windowLabel) },
            verifyRegistry: { _, _ in })
        try await registration.synchronize()
        XCTAssertEqual(attempts, [configured, discovered])
        XCTAssertEqual(discoveries, 1)
        XCTAssertEqual(applied, ["z"])
        primary.fails = false
        try await registration.synchronize()
        XCTAssertEqual(attempts, [configured, discovered])
        XCTAssertEqual(discoveries, 1)
        XCTAssertEqual(applied, ["z", "z"])
        XCTAssertFalse(fallback.closed)
        fallback.fails = true
        try await registration.synchronize()
        XCTAssertEqual(attempts, [configured, discovered, configured])
        XCTAssertEqual(discoveries, 2)
        XCTAssertEqual(applied, ["z", "z", "y"])
        XCTAssertTrue(fallback.closed)
        registration.stop()
        let count = attempts.count
        do { try await registration.synchronize(); XCTFail("stopped registration ran") } catch { }
        XCTAssertEqual(attempts.count, count)
    }

    func testUnderlyingRegistrationFailurePersistsAcrossRetryAndClearsOnRecovery() async throws {
        let endpoint = URL(string: "ws://registry.local:9002/ws")!
        let transport = Transport()
        transport.error = URLError(.cannotFindHost)
        let surfaces = [SurfAceRegistrationSurface(
            surfaceId: "sf_retry",
            panes: [.init(paneId: "1", paneLineageId: "stable-lineage", paneLabel: 12)]
        )]
        var visibleErrors: [String?] = []
        var logErrors: [String] = []
        let registration = SurfAceCentralRegistration(
            clientId: "stable-client-identity",
            configured: nil,
            discover: { [endpoint] },
            makeTransport: { _ in transport },
            snapshot: { surfaces },
            apply: { _, _ in }, verifyRegistry: { _, _ in },
            onError: { logErrors.append(($0 as? LocalizedError)?.errorDescription ?? $0.localizedDescription) },
            onConnectionError: { visibleErrors.append($0) }
        )

        for _ in 0..<2 {
            do { try await registration.synchronize(); XCTFail("hostname failure succeeded") } catch { }
            XCTAssertTrue(registration.lastError?.contains("registry.local:9002/ws") == true)
            XCTAssertTrue(registration.lastError?.contains("\(URLError.Code.cannotFindHost.rawValue)") == true)
            XCTAssertEqual(registration.status, .disconnected)
        }
        XCTAssertTrue(visibleErrors.contains { $0?.contains("registry.local:9002/ws") == true })
        XCTAssertTrue(logErrors.contains { $0.contains("\(URLError.Code.cannotFindHost.rawValue)") })
        XCTAssertEqual(transport.clients, ["stable-client-identity", "stable-client-identity"])

        transport.error = nil
        try await registration.synchronize()
        XCTAssertEqual(registration.status, .connected)
        XCTAssertNil(registration.lastError)
        XCTAssertEqual(visibleErrors.last!, nil)
        XCTAssertEqual(transport.registeredSurfaces, surfaces)
        registration.stop()
    }

    func testNumericDiscoveryTransportPrecedesSlowHostnameLookup() async throws {
        let hostname = URL(string: "ws://server.local:9001/")!
        let numeric = URL(string: "ws://192.0.2.1:9001/")!
        for code in [URLError.cannotConnectToHost, URLError.cannotFindHost] {
            let host = Transport()
            let address = Transport()
            address.error = URLError(code)
            var attempts: [URL] = []
            var applied = false
            let registration = SurfAceCentralRegistration(clientId: String(repeating: "b", count: 64), configured: nil,
                discover: { [hostname] },
                makeTransport: { url in attempts.append(url); return url == hostname ? host : address },
                transportFallbacks: { _ in [numeric] },
                snapshot: { [.init(surfaceId: "sf_one", panes: [.init(paneId: "1", paneLineageId: "lineage_one", paneLabel: 1)])] },
                apply: { _, _ in applied = true }, verifyRegistry: { _, _ in })
            try await registration.synchronize()
            XCTAssertEqual(attempts, [numeric, hostname])
            XCTAssertTrue(applied)
            registration.stop()
        }
    }

    func testClientRegisterRecoversUnnumberedPanesByTheirExistingLineage() async throws {
        let transport = Transport()
        transport.assignsPaneLabels = true
        let lineages = ["pl_split_after_outage", "pl_restore_after_outage", "pl_topology_after_outage"]
        let surfaces = [SurfAceRegistrationSurface(
            surfaceId: "sf_recovery",
            panes: lineages.enumerated().map { index, lineage in
                .init(paneId: String(index + 2), paneLineageId: lineage, paneLabel: 0)
            }
        )]
        var recovered: [String: Int64] = [:]
        let registration = SurfAceCentralRegistration(
            clientId: String(repeating: "c", count: 64),
            configured: URL(string: "ws://allocator.example:19430/"),
            discover: { [] },
            makeTransport: { _ in transport },
            snapshot: { surfaces },
            apply: { assignments, expected in
                XCTAssertEqual(expected, surfaces)
                let panes = try XCTUnwrap(assignments.first?.panes)
                recovered = Dictionary(uniqueKeysWithValues: panes.map { ($0.paneLineageId, $0.paneLabel) })
            }, verifyRegistry: { _, _ in }
        )
        try await registration.synchronize()

        XCTAssertEqual(transport.registeredSurfaces, surfaces)
        XCTAssertEqual(Set(transport.registeredSurfaces.flatMap(\.panes).map(\.paneLabel)), [0])
        XCTAssertEqual(Set(recovered.keys), Set(lineages))
        XCTAssertTrue(recovered.values.allSatisfy { $0 > 0 })
        XCTAssertEqual(Set(recovered.values).count, lineages.count)
        registration.stop()
    }

    func testPaneClaimOkFalseIsDistinguishedAsAnUnconfirmedAssignment() throws {
        let response = Data(#"{"id":"claim-rejected","op":"pane.claim","ok":false,"payload":null}"#.utf8)

        let refused = try SurfAceRegistrationWire.paneClaimAllocation(
            from: response, requestId: "claim-rejected", expectedAllocationGenerationV1: true
        )
        XCTAssertEqual(refused.paneLabel, 0)
        XCTAssertTrue(refused.warnings.contains("pane_claim_refused code=missing"))

        XCTAssertFalse(isPaneAllocatorUnavailable(SurfAceRegistrationError.stopped))
        XCTAssertFalse(isPaneAllocatorUnavailable(SurfAceRegistrationError.topologyChanged))

        let malformedSuccess = Data(#"{"id":"claim-malformed","op":"pane.claim","ok":true,"payload":{}}"#.utf8)
        let unusable = try SurfAceRegistrationWire.paneClaimAllocation(
            from: malformedSuccess, requestId: "claim-malformed", expectedAllocationGenerationV1: true
        )
        XCTAssertEqual(unusable.paneLabel, 0)
        XCTAssertTrue(unusable.warnings.contains("pane_claim_label_missing_or_unrecognized"))

        let unrelated = Data(#"{"id":"other-claim","op":"pane.claim","ok":true,"payload":{"paneLabel":44}}"#.utf8)
        let discarded = try SurfAceRegistrationWire.paneClaimAllocation(
            from: unrelated, requestId: "claim-malformed", expectedAllocationGenerationV1: true
        )
        XCTAssertEqual(discarded.paneLabel, 0)
        XCTAssertTrue(discarded.warnings.contains("pane_claim_correlation_mismatch"))

        let missingGeneration = Data(#"{"id":"claim-generation","op":"pane.claim","ok":true,"payload":{"paneLabel":1201}}"#.utf8)
        let allocation = try SurfAceRegistrationWire.paneClaimAllocation(
            from: missingGeneration, requestId: "claim-generation", expectedAllocationGenerationV1: true
        )
        XCTAssertEqual(allocation.paneLabel, 1201)
        XCTAssertNil(allocation.allocationGeneration)
        XCTAssertTrue(allocation.warnings.contains("pane_claim_generation_missing"))

        let malformedGeneration = Data(#"{"id":"claim-generation","op":"pane.claim","ok":true,"payload":{"paneLabel":1201,"allocationGeneration":"unknown"}}"#.utf8)
        let unrecognized = try SurfAceRegistrationWire.paneClaimAllocation(
            from: malformedGeneration, requestId: "claim-generation", expectedAllocationGenerationV1: true
        )
        XCTAssertEqual(unrecognized.paneLabel, 1201)
        XCTAssertNil(unrecognized.allocationGeneration)
        XCTAssertTrue(unrecognized.warnings.contains("pane_claim_generation_unrecognized"))
    }

    func testRegistrationProtocolRejectionPreservesServerErrorDetails() throws {
        let response = Data(#"{"id":"register-rejected","op":"client.register","ok":false,"payload":null,"error":{"code":"registration_denied","message":"client signature rejected"}}"#.utf8)
        XCTAssertThrowsError(try SurfAceRegistrationWire.assignments(
            from: response,
            requestId: "register-rejected",
            clientId: "stable-client",
            surfaces: [], expectedIdentity: .init(allocatorId: "alloc_home", fleetId: "fleet-home")
        )) { error in
            guard case let SurfAceRegistrationError.serverRejected(code, message) = error else {
                XCTFail("server protocol error was not retained")
                return
            }
            XCTAssertEqual(code, "registration_denied")
            XCTAssertEqual(message, "client signature rejected")
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

    func testUnboundLegacyLabelsBindBeforeRegistrationAndKeepLabelsTheRegistryHonors() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-fresh-binding-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let surfaceId = try addSavedSurface(to: &state, windowLabel: "c", paneLabel: 7)
        let original = try XCTUnwrap(state.liveSurfaces[surfaceId])
        try store.save(state)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("registry-binding.provisioned.json").path))

        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let clientId = String(repeating: "a", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        let endpoint = URL(string: "ws://127.0.0.1:24021/ws")!
        let transport = Transport()
        transport.registryIdentity = identity
        transport.assignedWindowLabels[surfaceId] = "c"
        let originalPane = try XCTUnwrap(original.panes["1"])
        let paneKey = "\(surfaceId):1:\(originalPane.paneLineageId)"
        transport.assignedPaneLabels[paneKey] = 7
        transport.assignedPaneGenerations[paneKey] = 107
        transport.assignedWindowGenerations[surfaceId] = 30
        var bindingAtRegistration: SurfAceRegistryBinding?
        var durableBindingAtRegistration: SurfAceRegistryBinding?
        transport.onInputRegister = { _ in
            bindingAtRegistration = await adapter.snapshot().registryBinding
            durableBindingAtRegistration = try? store.load()?.registryBinding
        }
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: endpoint, discovered: [], transports: [endpoint: transport]
        )

        try await registration.synchronize()
        registration.stop()

        XCTAssertEqual(bindingAtRegistration, .init(
            allocatorId: identity.allocatorId, clientId: clientId, fleetId: identity.fleetId
        ))
        XCTAssertEqual(durableBindingAtRegistration, bindingAtRegistration)
        let sent = try XCTUnwrap(transport.registrationInputs.last)
        XCTAssertEqual(sent.registryIdentity, identity)
        XCTAssertEqual(sent.surfaces.first?.surfaceId, surfaceId)
        XCTAssertEqual(sent.surfaces.first?.panes.first?.paneId, "1")
        XCTAssertEqual(sent.surfaces.first?.panes.first?.paneLineageId, originalPane.paneLineageId)
        XCTAssertEqual(sent.surfaces.first?.panes.first?.paneLabel, 0)
        XCTAssertNil(sent.surfaces.first?.panes.first?.allocationGeneration)

        let registered = try XCTUnwrap(store.load()?.liveSurfaces[surfaceId])
        let registeredPane = try XCTUnwrap(registered.panes["1"])
        XCTAssertEqual(registered.windowLabel, "c")
        XCTAssertEqual(registered.windowLabelConfirmed, true)
        XCTAssertEqual(registeredPane.paneLabel, 7)
        XCTAssertEqual(registeredPane.allocationGeneration, 107)
        XCTAssertEqual(registeredPane.paneLineageId, originalPane.paneLineageId)
        XCTAssertEqual(registeredPane.history.visible.content, originalPane.history.visible.content)
        XCTAssertEqual(registeredPane.target, originalPane.target)
    }

    func testFreshInstallBindsDurablyBeforeApplyingItsFirstRegistryLabels() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-first-install-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        try store.save(state)
        XCTAssertNil(state.registryBinding)
        XCTAssertFalse(FileManager.default.fileExists(atPath: root.appendingPathComponent("registry-binding.provisioned.json").path))

        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let clientId = String(repeating: "f", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_fresh", fleetId: "fresh-fleet")
        let endpoint = URL(string: "ws://127.0.0.1:24027/ws")!
        let transport = Transport()
        transport.registryIdentity = identity
        transport.assignedWindowLabels[surfaceId] = "k"
        let pane = try XCTUnwrap(state.liveSurfaces[surfaceId]?.panes["1"])
        let paneKey = "\(surfaceId):1:\(pane.paneLineageId)"
        transport.assignedPaneLabels[paneKey] = 61
        var bindingOnFirstRegistration: SurfAceRegistryBinding?
        var diskBindingOnFirstRegistration: SurfAceRegistryBinding?
        var labelStillUnconfirmedOnFirstRegistration: Bool?
        transport.onInputRegister = { _ in
            bindingOnFirstRegistration = await adapter.snapshot().registryBinding
            let saved = try? store.load()
            diskBindingOnFirstRegistration = saved?.registryBinding
            labelStillUnconfirmedOnFirstRegistration = saved?.liveSurfaces[surfaceId]?.windowLabelConfirmed == false
        }
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: endpoint, discovered: [], transports: [endpoint: transport]
        )

        try await registration.synchronize()
        registration.stop()

        let expectedBinding = SurfAceRegistryBinding(
            allocatorId: identity.allocatorId, clientId: clientId, fleetId: identity.fleetId
        )
        XCTAssertEqual(bindingOnFirstRegistration, expectedBinding)
        XCTAssertEqual(diskBindingOnFirstRegistration, expectedBinding)
        XCTAssertTrue(labelStillUnconfirmedOnFirstRegistration == true)
        let registered = try XCTUnwrap(store.load()?.liveSurfaces[surfaceId])
        XCTAssertEqual(registered.windowLabel, "k")
        XCTAssertEqual(registered.windowLabelConfirmed, true)
        XCTAssertEqual(registered.panes["1"]?.paneLabel, 61)
    }

    func testNewBindingWithoutRegistryRecordKeepsReadableStateAndTakesFreshLabels() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-new-allocation-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let surfaceId = try addSavedSurface(to: &state, windowLabel: "c", paneLabel: 7)
        let original = try XCTUnwrap(state.liveSurfaces[surfaceId])
        let originalPane = try XCTUnwrap(original.panes["1"])
        try store.save(state)

        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let clientId = String(repeating: "c", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_unrecorded", fleetId: "fresh-fleet")
        let endpoint = URL(string: "ws://127.0.0.1:24028/ws")!
        let transport = Transport()
        transport.registryIdentity = identity
        transport.nextPaneLabel = 1
        var bindingAtRegistration: SurfAceRegistryBinding?
        var durableBindingAtRegistration: SurfAceRegistryBinding?
        var labelsPendingAtRegistration: Bool?
        transport.onInputRegister = { input in
            bindingAtRegistration = await adapter.snapshot().registryBinding
            durableBindingAtRegistration = try? store.load()?.registryBinding
            let saved = await adapter.snapshot()
            labelsPendingAtRegistration = saved.liveSurfaces[surfaceId]?.windowLabelConfirmed == false
                && input.surfaces.first?.panes.first?.paneLabel == 0
                && input.surfaces.first?.panes.first?.allocationGeneration == nil
        }
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: endpoint, discovered: [], transports: [endpoint: transport]
        )

        try await registration.synchronize()
        registration.stop()

        let expectedBinding = SurfAceRegistryBinding(
            allocatorId: identity.allocatorId, clientId: clientId, fleetId: identity.fleetId
        )
        XCTAssertEqual(bindingAtRegistration, expectedBinding)
        XCTAssertEqual(durableBindingAtRegistration, expectedBinding)
        XCTAssertTrue(labelsPendingAtRegistration == true)
        XCTAssertEqual(transport.registrationInputs.first?.surfaces.map(\.surfaceId), [surfaceId])

        let registered = try XCTUnwrap(store.load()?.liveSurfaces[surfaceId])
        let registeredPane = try XCTUnwrap(registered.panes["1"])
        XCTAssertEqual(registered.windowLabel, "a")
        XCTAssertEqual(registered.windowLabelConfirmed, true)
        XCTAssertEqual(registeredPane.paneLabel, 1)
        XCTAssertNotEqual(registered.windowLabel, original.windowLabel)
        XCTAssertNotEqual(registeredPane.paneLabel, originalPane.paneLabel)
        XCTAssertEqual(registered.surfaceId, original.surfaceId)
        XCTAssertEqual(registered.topology, original.topology)
        XCTAssertEqual(registeredPane.paneId, originalPane.paneId)
        XCTAssertEqual(registeredPane.paneLineageId, originalPane.paneLineageId)
        XCTAssertEqual(registeredPane.history.visible.contentId, originalPane.history.visible.contentId)
        XCTAssertEqual(registeredPane.history.visible.content, originalPane.history.visible.content)
        XCTAssertEqual(registeredPane.history.visible.revision, originalPane.history.visible.revision)
        XCTAssertEqual(registeredPane.target, originalPane.target)
    }

    func testUnmarkedSurfacesAndRetainedTombstonesUseCurrentRegistryAllocations() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-retained-tombstones-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let liveSurfaceId = try addSavedSurface(to: &state, windowLabel: "c", paneLabel: 7)
        state.liveSurfaces[liveSurfaceId]?.windowLabelConfirmed = nil

        let retainedSurfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: state.surfaceSetRevision
        ).surface.surfaceId
        var retainedSurface = try XCTUnwrap(state.liveSurfaces[retainedSurfaceId])
        retainedSurface.windowLabel = "d"
        retainedSurface.windowLabelConfirmed = nil
        retainedSurface.allocationGeneration = 31
        var retainedPane = try XCTUnwrap(retainedSurface.panes["1"])
        retainedPane.paneLabel = 8
        retainedPane.allocationGeneration = 108
        retainedPane.history.visible.contentId = "retained-window-pane"
        retainedPane.history.visible.contentType = "html"
        retainedPane.history.visible.content = .object(["html": .string("<h1>retained window</h1>")])
        retainedSurface.panes["1"] = retainedPane
        state.liveSurfaces[retainedSurfaceId] = retainedSurface
        let split = try SurfAceLocklessTopologyOperations.paneSplit(
            state: &state, surfaceId: retainedSurfaceId, paneId: 1, count: 2,
            direction: "horizontal", expectedTopologyRevision: retainedSurface.topologyRevision
        )
        let retainedPaneId = try XCTUnwrap(split.newPaneIds.first)
        var splitSurface = try XCTUnwrap(state.liveSurfaces[retainedSurfaceId])
        var paneToRetain = try XCTUnwrap(splitSurface.panes[String(retainedPaneId)])
        paneToRetain.paneLabel = 9
        paneToRetain.allocationGeneration = 109
        paneToRetain.history.visible.contentId = "retained-pane-tombstone"
        paneToRetain.history.visible.contentType = "html"
        paneToRetain.history.visible.content = .object(["html": .string("<h1>retained pane</h1>")])
        splitSurface.panes[String(retainedPaneId)] = paneToRetain
        state.liveSurfaces[retainedSurfaceId] = splitSurface
        let paneClose = try SurfAceLocklessTopologyOperations.paneClose(
            state: &state, surfaceId: retainedSurfaceId, paneId: retainedPaneId,
            expectedTopologyRevision: split.topologyRevision
        )
        let retainedSurfaceAtClose = try XCTUnwrap(state.liveSurfaces[retainedSurfaceId])
        let originalRetainedPane = try XCTUnwrap(retainedSurfaceAtClose.paneTombstones.first?.pane)
        let windowClose = try SurfAceLocklessTopologyOperations.surfaceWindowClose(
            state: &state, surfaceId: retainedSurfaceId,
            expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: paneClose.topologyRevision
        )
        let originalTombstoneSurface = try XCTUnwrap(
            state.surfaceTombstones.first(where: { $0.tombstoneId == windowClose.tombstoneId })?.surface
        )
        try store.save(state)

        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let clientId = String(repeating: "d", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_tombstones", fleetId: "tombstone-fleet")
        let endpoint = URL(string: "ws://127.0.0.1:24029/ws")!
        let transport = Transport()
        transport.registryIdentity = identity
        transport.nextPaneLabel = 11
        var bindingAtFirstRegistration: SurfAceRegistryBinding?
        var firstSavedBinding: SurfAceRegistryBinding?
        transport.onInputRegister = { _ in
            bindingAtFirstRegistration = await adapter.snapshot().registryBinding
            firstSavedBinding = try? store.load()?.registryBinding
        }
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: endpoint, discovered: [], transports: [endpoint: transport]
        )
        try await registration.synchronize()
        let firstInput = try XCTUnwrap(transport.registrationInputs.first)
        let firstState = await adapter.snapshot()
        registration.stop()

        XCTAssertEqual(bindingAtFirstRegistration, .init(
            allocatorId: identity.allocatorId, clientId: clientId, fleetId: identity.fleetId
        ))
        XCTAssertEqual(firstSavedBinding, bindingAtFirstRegistration)
        XCTAssertEqual(firstInput.surfaces.map(\.surfaceId), [liveSurfaceId])
        XCTAssertEqual(firstInput.surfaces.first?.panes.first?.paneLabel, 0)
        XCTAssertNil(firstInput.surfaces.first?.panes.first?.allocationGeneration)
        let savedTombstone = try XCTUnwrap(firstState.surfaceTombstones.first)
        XCTAssertEqual(savedTombstone.tombstoneId, windowClose.tombstoneId)
        XCTAssertEqual(savedTombstone.surface.windowLabelConfirmed, false)
        XCTAssertEqual(savedTombstone.surface.panes["1"]?.history.visible.content, originalTombstoneSurface.panes["1"]?.history.visible.content)
        let unclaimedPaneTombstone = try XCTUnwrap(savedTombstone.surface.paneTombstones.first)
        XCTAssertEqual(unclaimedPaneTombstone.pane.paneLabel, 0)
        XCTAssertNil(unclaimedPaneTombstone.pane.allocationGeneration)
        XCTAssertEqual(unclaimedPaneTombstone.pane.history.visible.content, originalRetainedPane.history.visible.content)

        var stateAfterBinding = try XCTUnwrap(store.load())
        let restoredSurface = try SurfAceLocklessTopologyOperations.surfaceWindowRestore(
            state: &stateAfterBinding, tombstoneId: windowClose.tombstoneId,
            expectedSurfaceSetRevision: stateAfterBinding.surfaceSetRevision
        )
        XCTAssertEqual(restoredSurface.surface.windowLabel, "d")
        XCTAssertEqual(restoredSurface.surface.windowLabelConfirmed, false)
        try store.save(stateAfterBinding)
        let restoredTransport = Transport()
        restoredTransport.registryIdentity = identity
        restoredTransport.assignedWindowLabels = transport.assignedWindowLabels
        restoredTransport.assignedWindowLabels[retainedSurfaceId] = "z"
        restoredTransport.assignedWindowGenerations = transport.assignedWindowGenerations
        restoredTransport.assignedWindowGenerations[retainedSurfaceId] = 909
        restoredTransport.assignedPaneLabels = transport.assignedPaneLabels
        restoredTransport.assignedPaneGenerations = transport.assignedPaneGenerations
        restoredTransport.nextPaneLabel = transport.nextPaneLabel

        let restoredAdapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let restoreRegistration = centralRegistration(
            adapter: restoredAdapter, clientId: clientId, configured: endpoint,
            discovered: [], transports: [endpoint: restoredTransport]
        )
        try await restoreRegistration.synchronize()
        let inputAfterRestore = try XCTUnwrap(restoredTransport.registrationInputs.last)
        let requestedRestoredSurface = try XCTUnwrap(inputAfterRestore.surfaces.first(where: { $0.surfaceId == retainedSurfaceId }))
        XCTAssertEqual(requestedRestoredSurface.panes.first?.paneLabel, 0)
        XCTAssertNil(requestedRestoredSurface.panes.first?.allocationGeneration)
        let registeredState = await restoredAdapter.snapshot()
        let registeredSurface = try XCTUnwrap(registeredState.liveSurfaces[retainedSurfaceId])
        XCTAssertEqual(registeredSurface.windowLabel, "z")
        XCTAssertEqual(registeredSurface.allocationGeneration, 909)
        XCTAssertEqual(registeredSurface.topology, originalTombstoneSurface.topology)
        XCTAssertEqual(registeredSurface.panes["1"]?.paneLabel, 12)
        XCTAssertEqual(registeredSurface.panes["1"]?.history.visible.content, originalTombstoneSurface.panes["1"]?.history.visible.content)
        XCTAssertEqual(registeredSurface.paneTombstones.first?.pane.history.visible.content, originalRetainedPane.history.visible.content)

        let paneAllocation = try await restoreRegistration.claimPaneLabel(
            surfaceId: retainedSurfaceId, paneId: retainedPaneId,
            paneLineageId: originalRetainedPane.paneLineageId
        )
        restoreRegistration.stop()
        XCTAssertEqual(paneAllocation.paneLabel, 13)
        XCTAssertEqual(paneAllocation.allocationGeneration, 113)
        var stateAfterPaneClaim = try XCTUnwrap(store.load())
        let surfaceBeforePaneRestore = try XCTUnwrap(stateAfterPaneClaim.liveSurfaces[retainedSurfaceId])
        let paneRestore = try SurfAceLocklessTopologyOperations.paneRestore(
            state: &stateAfterPaneClaim, surfaceId: retainedSurfaceId,
            tombstoneId: try XCTUnwrap(surfaceBeforePaneRestore.paneTombstones.first?.tombstoneId),
            anchorPaneId: 1, direction: "horizontal",
            expectedTopologyRevision: surfaceBeforePaneRestore.topologyRevision,
            assignedPaneLabel: paneAllocation.paneLabel,
            assignedPaneGeneration: paneAllocation.allocationGeneration
        )
        try store.save(stateAfterPaneClaim)
        let restoredPane = try XCTUnwrap(stateAfterPaneClaim.liveSurfaces[retainedSurfaceId]?.panes[String(paneRestore.paneId)])
        XCTAssertEqual(restoredPane.paneId, originalRetainedPane.paneId)
        XCTAssertEqual(restoredPane.paneLineageId, originalRetainedPane.paneLineageId)
        XCTAssertEqual(restoredPane.paneLabel, paneAllocation.paneLabel)
        XCTAssertEqual(restoredPane.allocationGeneration, paneAllocation.allocationGeneration)
        XCTAssertEqual(restoredPane.history.visible.contentId, originalRetainedPane.history.visible.contentId)
        XCTAssertEqual(restoredPane.history.visible.content, originalRetainedPane.history.visible.content)
    }

    func testWhollyUndecodableSavedStateRegistersOneFreshWindow() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-undecodable-state-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        try Data("not a saved authority state".utf8).write(to: store.stateURL)

        var recovered = try XCTUnwrap(store.load())
        XCTAssertNil(recovered.registryBinding)
        XCTAssertTrue(recovered.liveSurfaces.isEmpty)
        let recoveredSurfaceSetRevision = recovered.surfaceSetRevision
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &recovered, expectedSurfaceSetRevision: recoveredSurfaceSetRevision
        ).surface.surfaceId
        try store.save(recovered)

        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let clientId = String(repeating: "e", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_recovered", fleetId: "recovered-fleet")
        let endpoint = URL(string: "ws://127.0.0.1:24028/ws")!
        let transport = Transport()
        transport.registryIdentity = identity
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: endpoint, discovered: [], transports: [endpoint: transport]
        )

        try await registration.synchronize()
        registration.stop()

        let registered = try XCTUnwrap(store.load())
        XCTAssertEqual(registered.registryBinding?.allocatorId, identity.allocatorId)
        XCTAssertEqual(registered.liveSurfaces.count, 1)
        XCTAssertNotNil(registered.liveSurfaces[surfaceId])
        XCTAssertEqual(registered.liveSurfaces[surfaceId]?.windowLabelConfirmed, true)
        XCTAssertEqual(transport.clients, [clientId])
    }

    func testValidRegistryEndpointAfterInvalidIdentityEndpointIsBoundAndUsed() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-valid-after-invalid-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(state: &state, expectedSurfaceSetRevision: 0)
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let clientId = String(repeating: "d", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_available", fleetId: "available-fleet")
        let invalidURL = URL(string: "ws://invalid.invalid/ws")!
        let validURL = URL(string: "ws://available.invalid/ws")!
        let invalid = Transport()
        invalid.registryIdentity = SurfAceRegistryIdentity(allocatorId: "", fleetId: identity.fleetId)
        let valid = Transport()
        valid.registryIdentity = identity
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: invalidURL,
            discovered: [validURL], transports: [invalidURL: invalid, validURL: valid]
        )

        try await registration.synchronize()
        registration.stop()

        XCTAssertEqual(invalid.identityReads, 1)
        XCTAssertTrue(invalid.clients.isEmpty)
        XCTAssertEqual(valid.clients, [clientId])
        let registered = await adapter.snapshot()
        XCTAssertEqual(registered.registryBinding?.allocatorId, identity.allocatorId)
    }

    func testSurfaceAdvertisementDoesNotRebindAClientWithoutARoleServer() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-surface-advertisement-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(state: &state, expectedSurfaceSetRevision: 0)
        let clientId = String(repeating: "c", count: 64)
        let home = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "home-fleet")
        let foreign = SurfAceRegistryIdentity(allocatorId: "alloc_foreign", fleetId: "foreign-fleet")
        state.registryBinding = .init(allocatorId: home.allocatorId, clientId: clientId, fleetId: home.fleetId)
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let browser = DiscoveryBrowser()
        let clock = DiscoveryClock()
        let discovery = SurfAceCentralDiscovery(makeBrowser: { browser }, sleep: { try await clock.sleep($0) })
        let advertisement = discoveryService(name: "surface-only")
        advertisement.resolvedRole = "surface"
        let advertisedURL = URL(string: "ws://example.test:43867/ws")!
        let surfaceTransport = Transport()
        surfaceTransport.registryIdentity = foreign
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: nil, discovered: [],
            transports: [advertisedURL: surfaceTransport], discoverOverride: { await discovery.discover() }
        )
        var failedToFindServer = false
        let attempt = Task { @MainActor in
            do { try await registration.synchronize() } catch { failedToFindServer = true }
        }

        await until { browser.started }
        discovery.netServiceBrowser(browser, didFind: advertisement, moreComing: false)
        discovery.netServiceDidResolveAddress(advertisement)
        clock.permits += 1
        await attempt.value
        registration.stop()

        XCTAssertTrue(failedToFindServer)
        XCTAssertTrue(advertisement.stopped)
        XCTAssertEqual(surfaceTransport.identityReads, 0)
        XCTAssertTrue(surfaceTransport.clients.isEmpty)
        let finalState = await adapter.snapshot()
        XCTAssertEqual(finalState.registryBinding?.allocatorId, home.allocatorId)
    }

    func testInterruptedBindingBeforeDuringAndAfterDurableBoundaryRecoversAutomatically() async throws {
        for interruption in 0...2 {
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-bind-interruption-\(interruption)-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            defer { try? FileManager.default.removeItem(at: root) }
            let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
            var state = try SurfAceLocklessAuthorityState.empty()
            let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
                state: &state, expectedSurfaceSetRevision: 0
            ).surface.surfaceId
            try store.save(state)
            let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
            let clientId = String(repeating: "b", count: 64)
            let identity = SurfAceRegistryIdentity(allocatorId: "alloc_boundary", fleetId: "boundary-fleet")
            let endpoint = URL(string: "ws://boundary-\(interruption).invalid/ws")!
            let transport = Transport()
            transport.registryIdentity = identity
            if interruption == 2 { transport.failRegistrationOnce = true }
            var didInterrupt = false
            let bindOverride: @MainActor (SurfAceRegistryIdentity, [SurfAceRegistrationSurface]) async throws -> Void = {
                target, surfaces in
                if interruption == 0 && !didInterrupt {
                    didInterrupt = true
                    throw URLError(.networkConnectionLost)
                }
                _ = try await adapter.bindRegistryIdentity(
                    target, clientId: clientId, expectedSurfaces: surfaces, allowRebinding: true
                )
                if interruption == 1 && !didInterrupt {
                    didInterrupt = true
                    throw URLError(.networkConnectionLost)
                }
            }
            let registration = centralRegistration(
                adapter: adapter, clientId: clientId, configured: endpoint, discovered: [],
                transports: [endpoint: transport], bindRegistryOverride: bindOverride
            )
            var firstAttemptFailed = false
            do { try await registration.synchronize() } catch { firstAttemptFailed = true }
            XCTAssertTrue(firstAttemptFailed, "interruption case \(interruption) should need one retry")
            let interruptedState = await adapter.snapshot()
            if interruption == 0 {
                XCTAssertNil(interruptedState.registryBinding)
                XCTAssertTrue(transport.clients.isEmpty)
            } else {
                XCTAssertEqual(interruptedState.registryBinding?.allocatorId, identity.allocatorId)
            }

            try await registration.synchronize()
            registration.stop()
            let registered = try XCTUnwrap(store.load())
            XCTAssertEqual(registered.registryBinding?.allocatorId, identity.allocatorId)
            XCTAssertEqual(registered.liveSurfaces[surfaceId]?.windowLabelConfirmed, true)
            XCTAssertEqual(registration.status, .disconnected)
            XCTAssertFalse(transport.clients.isEmpty)
        }
    }

    func testBoundClientPrefersMatchingRegistryAndReturnsWhenItIsTheOnlyAvailableServer() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-rebind-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let surfaceId = try addSavedSurface(to: &state, windowLabel: "b", paneLabel: 3)
        let clientId = String(repeating: "b", count: 64)
        let homeIdentity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        let replacementIdentity = SurfAceRegistryIdentity(allocatorId: "alloc_next", fleetId: homeIdentity.fleetId)
        state.registryBinding = .init(
            allocatorId: homeIdentity.allocatorId, clientId: clientId, fleetId: homeIdentity.fleetId
        )
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let homeURL = URL(string: "ws://127.0.0.1:24022/ws")!
        let replacementURL = URL(string: "ws://127.0.0.1:24023/ws")!
        let home = Transport()
        home.registryIdentity = homeIdentity
        home.assignedWindowLabels[surfaceId] = "b"
        home.assignedWindowGenerations[surfaceId] = 30
        let savedPane = try XCTUnwrap(state.liveSurfaces[surfaceId]?.panes["1"])
        let savedPaneKey = "\(surfaceId):1:\(savedPane.paneLineageId)"
        home.assignedPaneLabels[savedPaneKey] = 3
        home.assignedPaneGenerations[savedPaneKey] = 103
        let replacement = Transport()
        replacement.registryIdentity = replacementIdentity

        let matchingRegistration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: replacementURL,
            discovered: [homeURL], transports: [homeURL: home, replacementURL: replacement]
        )
        try await matchingRegistration.synchronize()
        matchingRegistration.stop()
        XCTAssertEqual(home.clients, [clientId])
        XCTAssertTrue(replacement.clients.isEmpty)
        let afterMatching = await adapter.snapshot()
        XCTAssertEqual(afterMatching.registryBinding?.allocatorId, homeIdentity.allocatorId)
        let homeSurface = try XCTUnwrap(afterMatching.liveSurfaces[surfaceId])
        let homePane = try XCTUnwrap(homeSurface.panes["1"])
        XCTAssertEqual(homeSurface.windowLabel, "b")
        XCTAssertEqual(homeSurface.allocationGeneration, 30)
        XCTAssertEqual(homePane.paneLabel, 3)
        XCTAssertEqual(homePane.allocationGeneration, 103)
        XCTAssertEqual(homeSurface.topology, state.liveSurfaces[surfaceId]?.topology)
        XCTAssertEqual(homePane.history.visible.content, state.liveSurfaces[surfaceId]?.panes["1"]?.history.visible.content)

        let restartedHomeURL = URL(string: "ws://127.0.0.1:24025/ws")!
        let restartedHome = Transport()
        restartedHome.registryIdentity = homeIdentity
        restartedHome.assignedWindowLabels[surfaceId] = "b"
        restartedHome.assignedWindowGenerations[surfaceId] = 30
        restartedHome.assignedPaneLabels[savedPaneKey] = 3
        restartedHome.assignedPaneGenerations[savedPaneKey] = 103
        let reconnectRegistration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: restartedHomeURL,
            discovered: [], transports: [restartedHomeURL: restartedHome]
        )
        try await reconnectRegistration.synchronize()
        XCTAssertEqual(reconnectRegistration.status, .connected)
        let afterRestart = await adapter.snapshot()
        let restartedSurface = try XCTUnwrap(afterRestart.liveSurfaces[surfaceId])
        let restartedPane = try XCTUnwrap(restartedSurface.panes["1"])
        XCTAssertEqual(afterRestart.registryBinding?.allocatorId, homeIdentity.allocatorId)
        XCTAssertEqual(restartedSurface.windowLabel, "b")
        XCTAssertEqual(restartedSurface.allocationGeneration, 30)
        XCTAssertEqual(restartedPane.paneLabel, 3)
        XCTAssertEqual(restartedPane.allocationGeneration, 103)
        XCTAssertEqual(restartedPane.history.visible.content, homePane.history.visible.content)
        XCTAssertEqual(restartedSurface.topology, homeSurface.topology)
        reconnectRegistration.stop()

        let rebindRegistration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: replacementURL,
            discovered: [], transports: [replacementURL: replacement]
        )
        try await rebindRegistration.synchronize()
        rebindRegistration.stop()
        let rebound = await adapter.snapshot()
        XCTAssertEqual(rebound.registryBinding?.allocatorId, replacementIdentity.allocatorId)
        XCTAssertEqual(rebound.registryBinding?.fleetId, homeIdentity.fleetId)

        let returningHome = Transport()
        returningHome.registryIdentity = homeIdentity
        let keepReplacement = centralRegistration(
            adapter: adapter, clientId: clientId, configured: replacementURL,
            discovered: [homeURL], transports: [homeURL: returningHome, replacementURL: replacement]
        )
        try await keepReplacement.synchronize()
        keepReplacement.stop()
        XCTAssertTrue(returningHome.clients.isEmpty)
        XCTAssertEqual(replacement.clients, [clientId, clientId])
        let stillOnReplacement = await adapter.snapshot()
        XCTAssertEqual(stillOnReplacement.registryBinding?.allocatorId, replacementIdentity.allocatorId)

        let formerRegistry = Transport()
        formerRegistry.registryIdentity = homeIdentity
        let returnAttempt = centralRegistration(
            adapter: adapter, clientId: clientId, configured: homeURL,
            discovered: [], transports: [homeURL: formerRegistry]
        )
        try await returnAttempt.synchronize()
        returnAttempt.stop()
        XCTAssertEqual(formerRegistry.identityReads, 1)
        XCTAssertEqual(formerRegistry.clients, [clientId])
        let returned = await adapter.snapshot()
        XCTAssertEqual(returned.registryBinding?.allocatorId, homeIdentity.allocatorId)
    }

    func testRegistrationFromAnotherClientFollowsAnsweringRegistryAndRetriesAsThisClient() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-reply-reset-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let surfaceId = try addSavedSurface(to: &state, windowLabel: "b", paneLabel: 2)
        let clientId = String(repeating: "c", count: 64)
        let oldIdentity = SurfAceRegistryIdentity(allocatorId: "alloc_before_reset", fleetId: "fleet-before")
        let newIdentity = SurfAceRegistryIdentity(allocatorId: "alloc_after_reset", fleetId: "fleet-after")
        state.registryBinding = .init(
            allocatorId: oldIdentity.allocatorId, clientId: clientId, fleetId: oldIdentity.fleetId
        )
        try store.save(state)

        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let endpoint = URL(string: "ws://127.0.0.1:24027/ws")!
        let transport = Transport()
        transport.registryIdentity = oldIdentity
        transport.queuedReplies = [SurfAceRegistrationReply(
            assignments: [],
            projection: SurfAceRegistrationProjection(
                directEndpoint: nil, prePairDescribeV1: false, allocationGenerationV1: false,
                endpointLease: nil, completedPaneReleaseIds: [], completedWindowReleaseIds: []
            ),
            warnings: ["registration_client_identity_mismatch"],
            registryIdentity: newIdentity, discarded: true, needsRetry: true
        )]
        transport.nextRegistryIdentityAfterQueuedReply = newIdentity
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: endpoint,
            discovered: [], transports: [endpoint: transport]
        )

        try await registration.synchronize()
        XCTAssertEqual(registration.status, .connected)
        registration.stop()

        XCTAssertEqual(transport.clients, [clientId, clientId])
        XCTAssertEqual(transport.registrationInputs.count, 2)
        let rebound = await adapter.snapshot()
        XCTAssertEqual(rebound.registryBinding?.allocatorId, newIdentity.allocatorId)
        XCTAssertEqual(rebound.registryBinding?.clientId, clientId)
        let restored = try XCTUnwrap(rebound.liveSurfaces[surfaceId])
        XCTAssertEqual(restored.panes["1"]?.history.visible.contentId, "content-\(surfaceId)")
        XCTAssertEqual(restored.panes["1"]?.history.visible.content,
                       state.liveSurfaces[surfaceId]?.panes["1"]?.history.visible.content)
        XCTAssertEqual(restored.windowLabel, "a")
        XCTAssertEqual(restored.windowLabelConfirmed, true)
    }

    func testRegistrationDoesNotApplyClaimsBeforeAnsweringRegistryBindingPersists() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-unpersisted-reply-reset-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let surfaceId = try addSavedSurface(to: &state, windowLabel: "b", paneLabel: 2)
        let paneLineageId = try XCTUnwrap(state.liveSurfaces[surfaceId]?.panes["1"]?.paneLineageId)
        let clientId = String(repeating: "d", count: 64)
        let oldIdentity = SurfAceRegistryIdentity(allocatorId: "alloc_before_reset", fleetId: "fleet-before")
        let newIdentity = SurfAceRegistryIdentity(allocatorId: "alloc_after_reset", fleetId: "fleet-after")
        state.registryBinding = .init(
            allocatorId: oldIdentity.allocatorId, clientId: clientId, fleetId: oldIdentity.fleetId
        )
        try store.save(state)

        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let endpoint = URL(string: "ws://127.0.0.1:24028/ws")!
        let transport = Transport()
        transport.registryIdentity = newIdentity
        let newRegistryReply = SurfAceRegistrationReply(
            assignments: [SurfAceRegistrationAssignment(
                surfaceId: surfaceId, windowLabel: "a", panes: [
                    .init(paneId: "1", paneLineageId: paneLineageId, paneLabel: 9)
                ]
            )],
            projection: SurfAceRegistrationProjection(
                directEndpoint: nil, prePairDescribeV1: false, allocationGenerationV1: false,
                endpointLease: nil, completedPaneReleaseIds: [], completedWindowReleaseIds: []
            ),
            registryIdentity: newIdentity
        )
        transport.queuedReplies = Array(repeating: newRegistryReply, count: 3)
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: endpoint,
            discovered: [], transports: [endpoint: transport],
            bindRegistryOverride: { _, _ in throw SurfAceRegistrationError.topologyChanged }
        )

        try await registration.synchronize()
        XCTAssertEqual(registration.status, .connected)
        registration.stop()

        let unchanged = await adapter.snapshot()
        XCTAssertEqual(unchanged.registryBinding?.allocatorId, oldIdentity.allocatorId)
        let surface = try XCTUnwrap(unchanged.liveSurfaces[surfaceId])
        XCTAssertEqual(surface.windowLabel, "b")
        XCTAssertEqual(surface.panes["1"]?.paneLabel, 2)
        XCTAssertEqual(surface.panes["1"]?.history.visible.contentId, "content-\(surfaceId)")
    }

    func testRefusedPaneClaimRotatesOnlyThatIdentityAndPreservesReadableContentAndLayout() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-refused-pane-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let refusedSurfaceId = try addSavedSurface(to: &state, windowLabel: "c", paneLabel: 7)
        let otherSurfaceId = try addSavedSurface(to: &state, windowLabel: "d", paneLabel: 8)
        let clientId = String(repeating: "c", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        state.registryBinding = .init(allocatorId: identity.allocatorId, clientId: clientId, fleetId: identity.fleetId)
        try store.save(state)
        let original = try XCTUnwrap(state.liveSurfaces[refusedSurfaceId])
        let originalPane = try XCTUnwrap(original.panes["1"])
        let otherPane = try XCTUnwrap(state.liveSurfaces[otherSurfaceId]?.panes["1"])
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let endpoint = URL(string: "ws://127.0.0.1:24024/ws")!
        let transport = Transport()
        transport.registryIdentity = identity
        transport.refusedClaim = .pane(
            surfaceId: refusedSurfaceId, paneId: "1", paneLineageId: originalPane.paneLineageId
        )
        transport.assignedWindowLabels[refusedSurfaceId] = "c"
        transport.assignedWindowLabels[otherSurfaceId] = "d"
        transport.assignedWindowGenerations[refusedSurfaceId] = 30
        transport.assignedWindowGenerations[otherSurfaceId] = 30
        let otherPaneKey = "\(otherSurfaceId):1:\(otherPane.paneLineageId)"
        transport.assignedPaneLabels[otherPaneKey] = 8
        transport.assignedPaneGenerations[otherPaneKey] = 108
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: endpoint, discovered: [], transports: [endpoint: transport]
        )

        try await registration.synchronize()
        XCTAssertEqual(registration.status, .connected)
        registration.stop()
        XCTAssertEqual(registration.status, .disconnected)

        let registered = await adapter.snapshot()
        let refusedSurface = try XCTUnwrap(registered.liveSurfaces[refusedSurfaceId])
        let newPane = try XCTUnwrap(refusedSurface.panes.values.first)
        let unchangedSurface = try XCTUnwrap(registered.liveSurfaces[otherSurfaceId])
        let unchangedPane = try XCTUnwrap(unchangedSurface.panes["1"])
        XCTAssertEqual(refusedSurface.surfaceId, refusedSurfaceId)
        XCTAssertNotEqual(newPane.paneId, originalPane.paneId)
        XCTAssertNotEqual(newPane.paneLineageId, originalPane.paneLineageId)
        XCTAssertEqual(newPane.paneLabel, 700)
        XCTAssertEqual(newPane.history.visible.contentId, originalPane.history.visible.contentId)
        XCTAssertEqual(newPane.history.visible.content, originalPane.history.visible.content)
        XCTAssertEqual(newPane.target, originalPane.target)
        guard case .object(let layout) = refusedSurface.topology else {
            return XCTFail("expected the saved pane layout")
        }
        XCTAssertEqual(layout["type"], .string("pane"))
        XCTAssertEqual(layout["paneId"], .integer(newPane.paneId))
        XCTAssertEqual(unchangedSurface.windowLabel, "d")
        XCTAssertEqual(unchangedPane.paneId, otherPane.paneId)
        XCTAssertEqual(unchangedPane.paneLineageId, otherPane.paneLineageId)
        XCTAssertEqual(unchangedPane.paneLabel, 8)
        XCTAssertTrue(transport.registrationInputs.contains {
            $0.surfaces.contains { $0.surfaceId == refusedSurfaceId && $0.panes.contains { $0.paneId == "1" } }
        })
        XCTAssertEqual(transport.registrationInputs.last?.surfaces.first(where: { $0.surfaceId == refusedSurfaceId })?
            .panes.first?.paneId, String(newPane.paneId))
    }

    func testRefusedSurfaceClaimKeepsItsPanesAndContentUnderFreshSurfaceIdentity() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-refused-surface-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let refusedSurfaceId = try addSavedSurface(to: &state, windowLabel: "c", paneLabel: 7)
        let otherSurfaceId = try addSavedSurface(to: &state, windowLabel: "d", paneLabel: 8)
        let clientId = String(repeating: "d", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        state.registryBinding = .init(allocatorId: identity.allocatorId, clientId: clientId, fleetId: identity.fleetId)
        try store.save(state)
        let original = try XCTUnwrap(state.liveSurfaces[refusedSurfaceId])
        let originalPane = try XCTUnwrap(original.panes["1"])
        let otherPane = try XCTUnwrap(state.liveSurfaces[otherSurfaceId]?.panes["1"])
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let endpoint = URL(string: "ws://127.0.0.1:24025/ws")!
        let transport = Transport()
        transport.registryIdentity = identity
        transport.refusedClaim = .surface(surfaceId: refusedSurfaceId)
        transport.assignedWindowLabels[otherSurfaceId] = "d"
        transport.assignedWindowGenerations[otherSurfaceId] = 30
        let otherPaneKey = "\(otherSurfaceId):1:\(otherPane.paneLineageId)"
        transport.assignedPaneLabels[otherPaneKey] = 8
        transport.assignedPaneGenerations[otherPaneKey] = 108
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: endpoint, discovered: [], transports: [endpoint: transport]
        )

        try await registration.synchronize()
        XCTAssertEqual(registration.status, .connected)
        registration.stop()
        XCTAssertEqual(registration.status, .disconnected)

        let registered = await adapter.snapshot()
        XCTAssertNil(registered.liveSurfaces[refusedSurfaceId])
        let replacementSurface = try XCTUnwrap(registered.liveSurfaces.values.first {
            $0.sceneKeys == original.sceneKeys && $0.surfaceId != refusedSurfaceId
                && $0.panes["1"]?.paneLineageId == originalPane.paneLineageId
        })
        let replacementPane = try XCTUnwrap(replacementSurface.panes["1"])
        let unchangedSurface = try XCTUnwrap(registered.liveSurfaces[otherSurfaceId])
        let unchangedPane = try XCTUnwrap(unchangedSurface.panes["1"])
        XCTAssertNotEqual(replacementSurface.surfaceId, original.surfaceId)
        XCTAssertNotEqual(replacementSurface.windowLabel, original.windowLabel)
        XCTAssertEqual(replacementSurface.windowLabelConfirmed, true)
        XCTAssertGreaterThan(replacementPane.paneLabel, 0)
        XCTAssertEqual(replacementPane.paneId, originalPane.paneId)
        XCTAssertEqual(replacementPane.paneLineageId, originalPane.paneLineageId)
        XCTAssertEqual(replacementPane.history.visible.contentId, originalPane.history.visible.contentId)
        XCTAssertEqual(replacementPane.history.visible.content, originalPane.history.visible.content)
        XCTAssertEqual(replacementPane.target, originalPane.target)
        XCTAssertEqual(replacementSurface.topology, original.topology)
        XCTAssertEqual(unchangedSurface.windowLabel, "d")
        XCTAssertEqual(unchangedPane.paneId, otherPane.paneId)
        XCTAssertEqual(unchangedPane.paneLineageId, otherPane.paneLineageId)
        XCTAssertEqual(unchangedPane.paneLabel, 8)
        XCTAssertTrue(transport.registrationInputs.last?.surfaces.contains {
            $0.surfaceId == replacementSurface.surfaceId
        } ?? false)
        XCTAssertFalse(transport.registrationInputs.last?.surfaces.contains {
            $0.surfaceId == refusedSurfaceId
        } ?? true)
    }

    func testRefusedReleaseDropsOnlyThatIntentAndCompletesTheAcceptedRelease() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-refused-release-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let closedSurfaceId = try addSavedSurface(to: &state, windowLabel: "b", paneLabel: 1)
        let liveSurfaceId = try addSavedSurface(to: &state, windowLabel: "c", paneLabel: 2)
        let clientId = String(repeating: "f", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        state.registryBinding = .init(allocatorId: identity.allocatorId, clientId: clientId, fleetId: identity.fleetId)
        let closedSurface = try XCTUnwrap(state.liveSurfaces[closedSurfaceId])
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowFinalClose(
            state: &state, surfaceId: closedSurfaceId,
            expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: closedSurface.topologyRevision
        )
        let originalIntents = try XCTUnwrap(state.allocationReleaseIntents)
        let refusedPaneRelease = try XCTUnwrap(originalIntents.first(where: { $0.allocationKind == .pane }))
        let acceptedWindowRelease = try XCTUnwrap(originalIntents.first(where: { $0.allocationKind == .surface }))
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let endpoint = URL(string: "ws://127.0.0.1:24027/ws")!
        let transport = Transport()
        transport.registryIdentity = identity
        transport.refusedReleaseIds = [refusedPaneRelease.releaseId]
        transport.assignedWindowLabels[liveSurfaceId] = "c"
        transport.assignedWindowGenerations[liveSurfaceId] = 30
        let livePane = try XCTUnwrap(state.liveSurfaces[liveSurfaceId]?.panes["1"])
        let livePaneKey = "\(liveSurfaceId):1:\(livePane.paneLineageId)"
        transport.assignedPaneLabels[livePaneKey] = 2
        transport.assignedPaneGenerations[livePaneKey] = 102
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: endpoint, discovered: [], transports: [endpoint: transport]
        )

        try await registration.synchronize()
        let afterRecovery = await adapter.snapshot()
        let remaining = try XCTUnwrap(afterRecovery.allocationReleaseIntents)
        XCTAssertEqual(remaining.map(\.releaseId), [acceptedWindowRelease.releaseId])
        XCTAssertEqual(remaining.first?.status, .accepted)
        XCTAssertFalse(afterRecovery.surfaceTombstones.contains { $0.surface.surfaceId == closedSurfaceId })
        XCTAssertTrue(afterRecovery.terminalCloseRecords?.contains {
            $0.allocationKind == .surface && $0.surfaceId == closedSurfaceId
        } == true)
        XCTAssertTrue(transport.registrationInputs.contains {
            $0.pendingWindowReleases.contains { $0.releaseId == acceptedWindowRelease.releaseId }
                && $0.pendingPaneReleases.contains { $0.releaseId == refusedPaneRelease.releaseId }
        })

        try await registration.synchronize()
        registration.stop()
        XCTAssertTrue(transport.registrationInputs.last?.pendingPaneReleases.isEmpty == true)
        XCTAssertTrue(transport.registrationInputs.last?.pendingWindowReleases.isEmpty == true)
    }

    func testRegistryWideRejectionKeepsUnknownReleasePendingUntilRegistryRecovers() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-unknown-release-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let closedSurfaceId = try addSavedSurface(to: &state, windowLabel: "b", paneLabel: 1)
        let liveSurfaceId = try addSavedSurface(to: &state, windowLabel: "c", paneLabel: 2)
        let clientId = String(repeating: "d", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        state.registryBinding = .init(allocatorId: identity.allocatorId, clientId: clientId, fleetId: identity.fleetId)
        let closedSurface = try XCTUnwrap(state.liveSurfaces[closedSurfaceId])
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowFinalClose(
            state: &state, surfaceId: closedSurfaceId,
            expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: closedSurface.topologyRevision
        )
        let originalIntents = try XCTUnwrap(state.allocationReleaseIntents)
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let endpoint = URL(string: "ws://127.0.0.1:24025/ws")!
        let transport = Transport()
        transport.registryIdentity = identity
        transport.assignedWindowLabels[liveSurfaceId] = "c"
        transport.assignedWindowGenerations[liveSurfaceId] = 30
        let livePane = try XCTUnwrap(state.liveSurfaces[liveSurfaceId]?.panes["1"])
        let livePaneKey = "\(liveSurfaceId):1:\(livePane.paneLineageId)"
        transport.assignedPaneLabels[livePaneKey] = 2
        transport.assignedPaneGenerations[livePaneKey] = 102
        transport.unknownReleaseId = try XCTUnwrap(originalIntents.first(where: {
            $0.allocationKind == .surface
        })?.releaseId)
        transport.rejectsEveryRegistration = true
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: endpoint, discovered: [], transports: [endpoint: transport]
        )

        try await registration.synchronize()
        let afterUnknown = await adapter.snapshot()
        XCTAssertEqual(registration.status, .connected)
        XCTAssertTrue(afterUnknown.liveSurfaces[liveSurfaceId] != nil)
        XCTAssertTrue((afterUnknown.allocationReleaseIntents ?? []).allSatisfy { $0.status == .pending })
        XCTAssertTrue(transport.acceptedReleaseIds.isEmpty)
        XCTAssertTrue(transport.registrationInputs.contains {
            $0.pendingPaneReleases.isEmpty && $0.pendingWindowReleases.isEmpty
                && $0.surfaces.contains { $0.surfaceId == liveSurfaceId }
        })

        transport.rejectsEveryRegistration = false
        try await registration.synchronize()
        let afterRetry = await adapter.snapshot()
        XCTAssertEqual(registration.status, .connected)
        XCTAssertTrue((afterRetry.allocationReleaseIntents ?? []).allSatisfy { $0.status == .pending })
        XCTAssertTrue(transport.deliveredUnknownRelease)
        let unknownReleaseId = try XCTUnwrap(transport.unknownReleaseId)
        XCTAssertFalse(transport.acceptedReleaseIds.contains(unknownReleaseId))

        try await registration.synchronize()
        registration.stop()
        let afterDelivery = await adapter.snapshot()
        XCTAssertTrue((afterDelivery.allocationReleaseIntents ?? []).allSatisfy { $0.status == .accepted })
        XCTAssertEqual(transport.acceptedReleaseIds.filter { $0 == unknownReleaseId }.count, 1)
        XCTAssertFalse(afterDelivery.surfaceTombstones.contains { $0.surface.surfaceId == closedSurfaceId })
        XCTAssertTrue(afterDelivery.terminalCloseRecords?.contains {
            $0.allocationKind == .surface && $0.surfaceId == closedSurfaceId
        } == true)
        XCTAssertTrue(transport.registrationInputs.contains {
            !$0.pendingPaneReleases.isEmpty || !$0.pendingWindowReleases.isEmpty
        })
    }

    func testUnknownReleaseOutcomeKeepsReleasePendingWhileLiveSurfaceRegisters() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-unknown-release-clear-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let closedSurfaceId = try addSavedSurface(to: &state, windowLabel: "b", paneLabel: 1)
        let liveSurfaceId = try addSavedSurface(to: &state, windowLabel: "c", paneLabel: 2)
        let clientId = String(repeating: "d", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        state.registryBinding = .init(allocatorId: identity.allocatorId, clientId: clientId, fleetId: identity.fleetId)
        let closedSurface = try XCTUnwrap(state.liveSurfaces[closedSurfaceId])
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowFinalClose(
            state: &state, surfaceId: closedSurfaceId,
            expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: closedSurface.topologyRevision
        )
        let originalIntents = try XCTUnwrap(state.allocationReleaseIntents)
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let endpoint = URL(string: "ws://127.0.0.1:24029/ws")!
        let transport = Transport()
        transport.registryIdentity = identity
        transport.assignedWindowLabels[liveSurfaceId] = "c"
        transport.assignedWindowGenerations[liveSurfaceId] = 30
        let livePane = try XCTUnwrap(state.liveSurfaces[liveSurfaceId]?.panes["1"])
        let livePaneKey = "\(liveSurfaceId):1:\(livePane.paneLineageId)"
        transport.assignedPaneLabels[livePaneKey] = 2
        transport.assignedPaneGenerations[livePaneKey] = 102
        transport.unknownReleaseId = try XCTUnwrap(originalIntents.first(where: {
            $0.allocationKind == .surface
        })?.releaseId)
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: endpoint, discovered: [], transports: [endpoint: transport]
        )

        try await registration.synchronize()
        let afterUnknown = await adapter.snapshot()
        XCTAssertEqual(registration.status, .connected)
        XCTAssertTrue(afterUnknown.liveSurfaces[liveSurfaceId] != nil)
        XCTAssertTrue((afterUnknown.allocationReleaseIntents ?? []).allSatisfy { $0.status == .pending })

        try await registration.synchronize()
        registration.stop()
        let afterRetry = await adapter.snapshot()
        XCTAssertTrue((afterRetry.allocationReleaseIntents ?? []).allSatisfy { $0.status == .accepted })
        XCTAssertFalse(afterRetry.surfaceTombstones.contains { $0.surface.surfaceId == closedSurfaceId })
        XCTAssertTrue(afterRetry.terminalCloseRecords?.contains {
            $0.allocationKind == .surface && $0.surfaceId == closedSurfaceId
        } == true)
        XCTAssertTrue(transport.registrationInputs.contains {
            !$0.pendingPaneReleases.isEmpty || !$0.pendingWindowReleases.isEmpty
        })
    }

    func testFormerRegistryReleaseEvidenceStaysPendingAndIsNotSentAfterRebinding() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-former-release-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let closedSurfaceId = try addSavedSurface(to: &state, windowLabel: "b", paneLabel: 1)
        let liveSurfaceId = try addSavedSurface(to: &state, windowLabel: "c", paneLabel: 2)
        let clientId = String(repeating: "e", count: 64)
        let homeIdentity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        let replacementIdentity = SurfAceRegistryIdentity(allocatorId: "alloc_next", fleetId: "fleet-next")
        state.registryBinding = .init(
            allocatorId: homeIdentity.allocatorId, clientId: clientId, fleetId: homeIdentity.fleetId
        )
        let closedSurface = try XCTUnwrap(state.liveSurfaces[closedSurfaceId])
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowFinalClose(
            state: &state, surfaceId: closedSurfaceId,
            expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: closedSurface.topologyRevision
        )
        let originalIntents = try XCTUnwrap(state.allocationReleaseIntents)
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let endpoint = URL(string: "ws://127.0.0.1:24026/ws")!
        let transport = Transport()
        transport.registryIdentity = replacementIdentity
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: endpoint, discovered: [], transports: [endpoint: transport]
        )

        try await registration.synchronize()
        registration.stop()

        let rebound = await adapter.snapshot()
        XCTAssertEqual(rebound.registryBinding?.allocatorId, replacementIdentity.allocatorId)
        XCTAssertEqual(rebound.allocationReleaseIntents, originalIntents)
        XCTAssertTrue(transport.registrationInputs.allSatisfy {
            $0.pendingPaneReleases.isEmpty && $0.pendingWindowReleases.isEmpty
                && $0.surfaces.allSatisfy { $0.surfaceId == liveSurfaceId }
        })
    }

    func testMalformedSavedReleaseDoesNotBlockOtherRegistrationClaims() throws {
        var state = try SurfAceLocklessAuthorityState.empty()
        let malformedPaneSurfaceId = try addSavedSurface(to: &state, windowLabel: "b", paneLabel: 1)
        let malformedWindowSurfaceId = try addSavedSurface(to: &state, windowLabel: "c", paneLabel: 2)
        let liveSurfaceId = try addSavedSurface(to: &state, windowLabel: "d", paneLabel: 3)
        let clientId = String(repeating: "f", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "home-fleet")
        state.registryBinding = .init(
            allocatorId: identity.allocatorId, clientId: clientId, fleetId: identity.fleetId
        )
        let closedPaneSurface = try XCTUnwrap(state.liveSurfaces[malformedPaneSurfaceId])
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowFinalClose(
            state: &state, surfaceId: malformedPaneSurfaceId,
            expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: closedPaneSurface.topologyRevision
        )
        let closedWindowSurface = try XCTUnwrap(state.liveSurfaces[malformedWindowSurfaceId])
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowFinalClose(
            state: &state, surfaceId: malformedWindowSurfaceId,
            expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: closedWindowSurface.topologyRevision
        )
        var intents = try XCTUnwrap(state.allocationReleaseIntents)
        let paneReleaseIndex = try XCTUnwrap(intents.firstIndex {
            $0.allocationKind == .pane && $0.surfaceId == malformedPaneSurfaceId
        })
        let malformedPaneReleaseId = intents[paneReleaseIndex].releaseId
        intents[paneReleaseIndex].paneLabel = nil
        let windowReleaseIndex = try XCTUnwrap(intents.firstIndex {
            $0.allocationKind == .surface && $0.surfaceId == malformedWindowSurfaceId
        })
        let malformedWindowReleaseId = intents[windowReleaseIndex].releaseId
        intents[windowReleaseIndex].windowLabel = nil
        state.allocationReleaseIntents = intents

        let input = try SurfAceRegistrationInput(state: state, clientId: clientId)

        XCTAssertTrue(input.warnings.contains(
            "registration_saved_pane_release_unusable release=\(malformedPaneReleaseId)"
        ))
        XCTAssertTrue(input.warnings.contains(
            "registration_saved_window_release_unusable release=\(malformedWindowReleaseId)"
        ))
        XCTAssertEqual(input.pendingPaneReleases.count, 1)
        XCTAssertFalse(input.pendingPaneReleases.contains { $0.surfaceId == malformedPaneSurfaceId })
        XCTAssertTrue(input.pendingPaneReleases.contains { $0.surfaceId == malformedWindowSurfaceId })
        XCTAssertEqual(input.pendingWindowReleases.count, 1)
        XCTAssertTrue(input.pendingWindowReleases.contains { $0.surfaceId == malformedPaneSurfaceId })
        XCTAssertFalse(input.pendingWindowReleases.contains { $0.surfaceId == malformedWindowSurfaceId })
        XCTAssertEqual(input.surfaces.map(\.surfaceId), [liveSurfaceId])
    }

    func testPartiallyUnreadableSavedStateKeepsEveryOtherReadableSurface() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-partial-state-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let first = try addSavedSurface(to: &state, windowLabel: "a", paneLabel: 1)
        let unreadable = try addSavedSurface(to: &state, windowLabel: "b", paneLabel: 2)
        let third = try addSavedSurface(to: &state, windowLabel: "c", paneLabel: 3)
        try store.save(state)

        let data = try Data(contentsOf: store.stateURL)
        var document = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        var surfaces = try XCTUnwrap(document["liveSurfaces"] as? [String: Any])
        var damagedSurface = try XCTUnwrap(surfaces[unreadable] as? [String: Any])
        var damagedPanes = try XCTUnwrap(damagedSurface["panes"] as? [String: Any])
        damagedPanes["1"] = "unreadable pane record"
        damagedSurface["panes"] = damagedPanes
        surfaces[unreadable] = damagedSurface
        document["liveSurfaces"] = surfaces
        document["registryBinding"] = ["allocatorId": "", "clientId": "legacy-client", "fleetId": "fleet-home"]
        try JSONSerialization.data(withJSONObject: document, options: [.sortedKeys]).write(to: store.stateURL, options: .atomic)

        let recovered = try XCTUnwrap(store.load())
        XCTAssertNil(recovered.registryBinding)
        XCTAssertNil(recovered.liveSurfaces[unreadable])
        XCTAssertEqual(recovered.liveSurfaces[first]?.panes["1"]?.history.visible.contentId, "content-\(first)")
        XCTAssertEqual(recovered.liveSurfaces[third]?.panes["1"]?.history.visible.contentId, "content-\(third)")
        XCTAssertEqual(recovered.liveSurfaces[first]?.panes["1"]?.history.visible.content,
                       state.liveSurfaces[first]?.panes["1"]?.history.visible.content)
        XCTAssertEqual(recovered.liveSurfaces[third]?.panes["1"]?.target,
                       state.liveSurfaces[third]?.panes["1"]?.target)

        try Data("unreadable state".utf8).write(to: store.stateURL, options: .atomic)
        XCTAssertTrue(try XCTUnwrap(store.load()).liveSurfaces.isEmpty)
    }

    func testBindingReadbackReconcilesCommittedDiskCandidateBeforeForeignRetry() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-readback-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(state: &state, expectedSurfaceSetRevision: 0)
        try store.save(state)
        let before = try XCTUnwrap(store.load())
        let coordinator = try SurfAceLocklessTransactionCoordinator(state: before, store: store)
        let home = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        let foreign = SurfAceRegistryIdentity(allocatorId: "alloc_foreign", fleetId: "fleet-foreign")
        let binding = SurfAceRegistryBinding(allocatorId: home.allocatorId,
                                              clientId: "readback-client", fleetId: home.fleetId)
        var committed = before
        committed.registryBinding = binding
        committed.generation += 1
        try store.save(committed)
        let reconciled = try await coordinator.reconcileRegistryBinding(binding)
        XCTAssertEqual(reconciled.registryBinding, binding)
        XCTAssertEqual(reconciled, committed)
        do {
            _ = try await coordinator.reconcileRegistryBinding(.init(
                allocatorId: foreign.allocatorId, clientId: "readback-client", fleetId: foreign.fleetId
            ))
            XCTFail("foreign identity replaced ambiguous committed candidate")
        } catch { }
        let afterForeign = await coordinator.snapshot()
        XCTAssertEqual(afterForeign, committed)
    }

    func testRegistryIdentityWireRejectsMissingAndMismatchedResponses() throws {
        let valid = Data(#"{"id":"identity-1","op":"fleet.topology","type":"response","v":1,"ok":true,"payload":{"registryIdentity":{"allocatorId":"alloc_home","fleetId":"fleet-home"}}}"#.utf8)
        XCTAssertEqual(try SurfAceRegistrationWire.registryIdentity(from: valid, requestId: "identity-1"),
                       .init(allocatorId: "alloc_home", fleetId: "fleet-home"))
        let missing = Data(#"{"id":"identity-1","op":"fleet.topology","type":"response","v":1,"ok":true,"payload":{}}"#.utf8)
        XCTAssertThrowsError(try SurfAceRegistrationWire.registryIdentity(from: missing, requestId: "identity-1"))
        XCTAssertThrowsError(try SurfAceRegistrationWire.registryIdentity(from: valid, requestId: "different"))
    }

    func testRegistryIdentityWireUsesRequestedIdentityAndWarnsOnUnknownTopologyVersion() {
        let expected = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        let response = Data(#"{"id":"identity-1","op":"fleet.topology","type":"response","v":9,"ok":true,"payload":{}}"#.utf8)
        let read = SurfAceRegistrationWire.registryIdentityReply(
            from: response, requestId: "identity-1", fallbackIdentity: expected
        )
        XCTAssertEqual(read.identity, expected)
        XCTAssertTrue(read.warnings.contains("topology_version_unrecognized"))
        XCTAssertTrue(read.warnings.contains("topology_registry_identity_missing_or_unrecognized"))
    }

    func testRegistrationResponseUsesRequestedIdentityWhenMissingAndRebindsToAnsweringRegistry() throws {
        let expected = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        let matching = Data(#"{"id":"register-1","op":"client.register","ok":true,"payload":{"clientId":"stable-client","registryIdentity":{"allocatorId":"alloc_home","fleetId":"fleet-home"},"surfaces":[]}}"#.utf8)
        let matchingReply = try SurfAceRegistrationWire.registration(
            from: matching, requestId: "register-1", clientId: "stable-client",
            surfaces: [], expectedIdentity: expected
        )
        XCTAssertEqual(matchingReply.registryIdentity, expected)
        XCTAssertFalse(matchingReply.discarded)
        let foreign = Data(#"{"id":"register-1","op":"client.register","ok":true,"payload":{"clientId":"stable-client","registryIdentity":{"allocatorId":"alloc_foreign","fleetId":"fleet-foreign"},"surfaces":[]}}"#.utf8)
        let missing = Data(#"{"id":"register-1","op":"client.register","ok":true,"payload":{"clientId":"stable-client","surfaces":[]}}"#.utf8)
        let changed = try SurfAceRegistrationWire.registration(
            from: foreign, requestId: "register-1", clientId: "stable-client",
            surfaces: [], expectedIdentity: expected
        )
        XCTAssertEqual(changed.registryIdentity, .init(allocatorId: "alloc_foreign", fleetId: "fleet-foreign"))
        XCTAssertTrue(changed.warnings.contains("registration_registry_identity_changed"))
        XCTAssertFalse(changed.discarded)
        let fallback = try SurfAceRegistrationWire.registration(
            from: missing, requestId: "register-1", clientId: "stable-client",
            surfaces: [], expectedIdentity: expected
        )
        XCTAssertEqual(fallback.registryIdentity, expected)
        XCTAssertFalse(fallback.warnings.contains("registration_client_identity_missing_or_unrecognized"))
        XCTAssertTrue(fallback.warnings.contains("registration_registry_identity_missing_or_unrecognized"))

        let missingClient = Data(#"{"id":"register-1","op":"client.register","ok":true,"payload":{"registryIdentity":{"allocatorId":"alloc_home","fleetId":"fleet-home"},"surfaces":[]}}"#.utf8)
        let missingClientReply = try SurfAceRegistrationWire.registration(
            from: missingClient, requestId: "register-1", clientId: "stable-client",
            surfaces: [], expectedIdentity: expected
        )
        XCTAssertFalse(missingClientReply.discarded)
        XCTAssertEqual(missingClientReply.registryIdentity, expected)
        XCTAssertTrue(missingClientReply.warnings.contains("registration_client_identity_missing_or_unrecognized"))

        let blankClient = Data(#"{"id":"register-1","op":"client.register","ok":true,"payload":{"clientId":"  ","registryIdentity":{"allocatorId":"alloc_home","fleetId":"fleet-home"},"surfaces":[]}}"#.utf8)
        let blankClientReply = try SurfAceRegistrationWire.registration(
            from: blankClient, requestId: "register-1", clientId: "stable-client",
            surfaces: [], expectedIdentity: expected
        )
        XCTAssertFalse(blankClientReply.discarded)
        XCTAssertEqual(blankClientReply.registryIdentity, expected)
        XCTAssertTrue(blankClientReply.warnings.contains("registration_client_identity_missing_or_unrecognized"))

        let answeringIdentity = SurfAceRegistryIdentity(allocatorId: "alloc_answering", fleetId: "fleet-answering")
        let anotherClient = Data(#"{"id":"register-1","op":"client.register","ok":true,"payload":{"clientId":"other-client","registryIdentity":{"allocatorId":"alloc_answering","fleetId":"fleet-answering"},"surfaces":[]}}"#.utf8)
        let discarded = try SurfAceRegistrationWire.registration(
            from: anotherClient, requestId: "register-1", clientId: "stable-client",
            surfaces: [], expectedIdentity: expected
        )
        XCTAssertTrue(discarded.discarded)
        XCTAssertTrue(discarded.needsRetry)
        XCTAssertEqual(discarded.registryIdentity, answeringIdentity)
        XCTAssertTrue(discarded.warnings.contains("registration_registry_identity_changed"))
        XCTAssertTrue(discarded.warnings.contains("registration_client_identity_mismatch"))

        let unrelatedRequest = Data(#"{"id":"another-request","op":"client.register","ok":true,"payload":{"clientId":"stable-client","registryIdentity":{"allocatorId":"alloc_home","fleetId":"fleet-home"},"surfaces":[]}}"#.utf8)
        let unrelatedReply = try SurfAceRegistrationWire.registration(
            from: unrelatedRequest, requestId: "register-1", clientId: "stable-client",
            surfaces: [], expectedIdentity: expected
        )
        XCTAssertTrue(unrelatedReply.discarded)
        XCTAssertTrue(unrelatedReply.needsRetry)
        XCTAssertTrue(unrelatedReply.warnings.contains("registration_reply_correlation_mismatch"))
    }

    func testWindowReleaseIntentIdMatchesRegistryFixedVector() throws {
        let clientId = String(repeating: "a", count: 64)
        // Pins the registry's clientId, closeRevision, surfaceId,
        // terminalRetirementRevision, tombstoneId, tombstoneKind,
        // windowGeneration, windowLabel JSON field order.
        let windowReleaseId = try XCTUnwrap(SurfAceLocklessAllocationReleaseIdentity.window(
            allocationGeneration: 30,
            clientId: clientId,
            closeRevision: 1,
            surfaceId: "sf_vector001",
            terminalRetirementRevision: 2,
            tombstoneId: "tombstone-vector-1",
            tombstoneKind: .surface,
            windowLabel: "b"
        ))
        XCTAssertEqual(windowReleaseId, "0b1022de07befe2eb8f519a54bfbe1ed6a7c1b00ee22eb6ae4c9b6acb2fcccc4")

        let legacyWindowReleaseId = try XCTUnwrap(SurfAceLocklessAllocationReleaseIdentity.legacyWindow(
            allocationGeneration: 30,
            clientId: clientId,
            closeRevision: 1,
            surfaceId: "sf_vector001",
            terminalRetirementRevision: 2,
            tombstoneId: "tombstone-vector-1",
            tombstoneKind: .surface,
            windowLabel: "b"
        ))
        XCTAssertEqual(legacyWindowReleaseId, "86d50ec15e4550d4bfe83db8d192d70b98102cd771996a8ab5a3b5880623e157")
    }

    func testFinalCloseRegistrationCarriesExactPaneAndWindowReleaseEvidence() throws {
        let clientId = String(repeating: "a", count: 64)
        let expectedIdentity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        var state = try SurfAceLocklessAuthorityState.empty()
        state.registryBinding = .init(
            allocatorId: expectedIdentity.allocatorId, clientId: clientId, fleetId: expectedIdentity.fleetId
        )
        let surfaceId = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        try SurfAceLocklessTopologyOperations.applyWindowLabels(
            state: &state, assignments: [(surfaceId: surfaceId, windowLabel: "b")]
        )
        var surface = try XCTUnwrap(state.liveSurfaces[surfaceId])
        surface.allocationGeneration = 30
        var pane = try XCTUnwrap(surface.panes["1"])
        pane.paneLabel = 1
        pane.allocationGeneration = 41
        surface.panes["1"] = pane
        state.liveSurfaces[surfaceId] = surface
        let close = try SurfAceLocklessTopologyOperations.surfaceWindowFinalClose(
            state: &state,
            surfaceId: surfaceId,
            expectedSurfaceSetRevision: state.surfaceSetRevision,
            expectedTopologyRevision: surface.topologyRevision
        )

        let input = try SurfAceRegistrationInput(state: state)
        XCTAssertTrue(input.surfaces.isEmpty)
        XCTAssertEqual(input.pendingPaneReleases.count, 1)
        XCTAssertEqual(input.pendingWindowReleases.count, 1)
        let paneRelease = try XCTUnwrap(input.pendingPaneReleases.first)
        let windowRelease = try XCTUnwrap(input.pendingWindowReleases.first)
        let committedCloseTopologyRevision = surface.topologyRevision + 1
        XCTAssertEqual(committedCloseTopologyRevision, 1)
        XCTAssertEqual(paneRelease.closeRevision, committedCloseTopologyRevision)
        XCTAssertEqual(paneRelease.tombstoneKind, "surface")
        XCTAssertEqual(paneRelease.tombstoneId, close.tombstoneId)
        XCTAssertEqual(windowRelease.closeRevision, committedCloseTopologyRevision)
        XCTAssertEqual(windowRelease.tombstoneKind, "surface")
        XCTAssertEqual(windowRelease.tombstoneId, close.tombstoneId)

        let paneEvidence = "{\"allocationGeneration\":41,\"clientId\":\"\(clientId)\",\"closeRevision\":\(committedCloseTopologyRevision),\"lineageId\":\"\(pane.paneLineageId)\",\"paneId\":\"1\",\"paneLabel\":1,\"surfaceId\":\"\(surfaceId)\",\"terminalRetirementRevision\":\(close.surfaceSetRevision),\"tombstoneId\":\"\(close.tombstoneId)\",\"tombstoneKind\":\"surface\"}"
        let expectedPaneReleaseId = SHA256.hash(data: Data(paneEvidence.utf8))
            .map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(paneRelease.releaseId, expectedPaneReleaseId)
        let windowEvidence = "{\"clientId\":\"\(clientId)\",\"closeRevision\":\(committedCloseTopologyRevision),\"surfaceId\":\"\(surfaceId)\",\"terminalRetirementRevision\":\(close.surfaceSetRevision),\"tombstoneId\":\"\(close.tombstoneId)\",\"tombstoneKind\":\"surface\",\"windowGeneration\":30,\"windowLabel\":\"b\"}"
        let expectedWindowReleaseId = SHA256.hash(data: Data(windowEvidence.utf8))
            .map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(windowRelease.releaseId, expectedWindowReleaseId)

        let legacyWindowReleaseId = try XCTUnwrap(SurfAceLocklessAllocationReleaseIdentity.legacyWindow(
            allocationGeneration: windowRelease.allocationGeneration,
            clientId: windowRelease.clientId,
            closeRevision: windowRelease.closeRevision,
            surfaceId: windowRelease.surfaceId,
            terminalRetirementRevision: windowRelease.terminalRetirementRevision,
            tombstoneId: windowRelease.tombstoneId,
            tombstoneKind: try XCTUnwrap(SurfAceLocklessTombstoneReclamation.Kind(rawValue: windowRelease.tombstoneKind)),
            windowLabel: windowRelease.windowLabel
        ))
        var legacyIntent = try XCTUnwrap(state.allocationReleaseIntents?.first { $0.allocationKind == .surface })
        legacyIntent.releaseId = legacyWindowReleaseId
        XCTAssertTrue(SurfAceLocklessAllocationReleaseIdentity.matches(legacyIntent))

        let legacyRequest = SurfAceWindowReleaseRequest(
            allocationGeneration: windowRelease.allocationGeneration,
            clientId: windowRelease.clientId,
            closeRevision: windowRelease.closeRevision,
            surfaceId: windowRelease.surfaceId,
            terminalRetirementRevision: windowRelease.terminalRetirementRevision,
            tombstoneId: windowRelease.tombstoneId,
            tombstoneKind: windowRelease.tombstoneKind,
            windowLabel: windowRelease.windowLabel,
            releaseId: legacyWindowReleaseId
        )
        let legacyRequestObject = try XCTUnwrap(
            JSONSerialization.jsonObject(with: JSONEncoder().encode(legacyRequest)) as? [String: Any]
        )
        XCTAssertEqual(legacyRequestObject["releaseId"] as? String, expectedWindowReleaseId)
        XCTAssertEqual(legacyRequestObject["windowGeneration"] as? Int64, 30)

        let request = try SurfAceRegistrationWire.requestData(
            clientId: clientId, input: input, id: "register-1"
        )
        let requestObject = try XCTUnwrap(JSONSerialization.jsonObject(with: request) as? [String: Any])
        let requestPayload = try XCTUnwrap(requestObject["payload"] as? [String: Any])
        XCTAssertEqual(requestPayload["allocationGenerationV1"] as? Bool, true)
        XCTAssertEqual(requestPayload["windowGenerationV1"] as? Bool, true)
        XCTAssertEqual((requestPayload["surfaces"] as? [Any])?.count, 0)
        let requestPaneReleases = try XCTUnwrap(requestPayload["pendingPaneReleases"] as? [[String: Any]])
        let requestWindowReleases = try XCTUnwrap(requestPayload["pendingWindowReleases"] as? [[String: Any]])
        XCTAssertEqual(requestPaneReleases.first?["releaseId"] as? String, paneRelease.releaseId)
        XCTAssertEqual(requestWindowReleases.first?["releaseId"] as? String, windowRelease.wireReleaseId)
        XCTAssertEqual(requestWindowReleases.first?["windowGeneration"] as? Int64, 30)
        XCTAssertNil(requestWindowReleases.first?["allocationGeneration"])

        func registrationResponse(paneReleaseIds: [String], windowReleaseIds: [String]) throws -> Data {
            try JSONSerialization.data(withJSONObject: [
                "id": "register-1",
                "op": "client.register",
                "ok": true,
                "payload": [
                    "clientId": clientId,
                    "registryIdentity": ["allocatorId": expectedIdentity.allocatorId, "fleetId": expectedIdentity.fleetId],
                    "surfaces": [],
                    "allocationGenerationV1": true,
                    "windowGenerationV1": true,
                    "completedPaneReleaseIds": paneReleaseIds,
                    "completedWindowReleaseIds": windowReleaseIds,
                ],
            ])
        }
        let accepted = try SurfAceRegistrationWire.registration(
            from: registrationResponse(
                paneReleaseIds: [paneRelease.releaseId], windowReleaseIds: [windowRelease.wireReleaseId]
            ),
            requestId: "register-1", clientId: clientId, surfaces: [], expectedIdentity: expectedIdentity,
            expectedAllocationGenerationV1: true,
            expectedWindowGenerationV1: true,
            expectedPaneReleaseIds: [paneRelease.releaseId],
            expectedWindowReleaseIds: [windowRelease.wireReleaseId]
        )
        XCTAssertEqual(accepted.projection.completedPaneReleaseIds, [paneRelease.releaseId])
        XCTAssertEqual(accepted.projection.completedWindowReleaseIds, [windowRelease.releaseId])
        let partial = try SurfAceRegistrationWire.registration(
            from: registrationResponse(paneReleaseIds: [], windowReleaseIds: []),
            requestId: "register-1", clientId: clientId, surfaces: [], expectedIdentity: expectedIdentity,
            expectedAllocationGenerationV1: true,
            expectedWindowGenerationV1: true,
            expectedPaneReleaseIds: [paneRelease.releaseId],
            expectedWindowReleaseIds: [windowRelease.wireReleaseId]
        )
        XCTAssertEqual(partial.projection.completedPaneReleaseIds, [])
        XCTAssertEqual(partial.projection.completedWindowReleaseIds, [])
        XCTAssertTrue(partial.warnings.contains("registration_pane_release_acknowledgements_incomplete"))
        XCTAssertTrue(partial.warnings.contains("registration_window_release_acknowledgements_incomplete"))
    }

    func testRegistrationKeepsLegacyRequestAndAcceptsNullableLeaseProjection() throws {
        let expected = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        let request = try SurfAceRegistrationWire.requestData(
            clientId: "stable-client", surfaces: [], id: "register-1"
        )
        let requestObject = try XCTUnwrap(JSONSerialization.jsonObject(with: request) as? [String: Any])
        let requestPayload = try XCTUnwrap(requestObject["payload"] as? [String: Any])
        XCTAssertEqual(Set(requestPayload.keys), Set([
            "clientId", "allocationGenerationV1", "windowGenerationV1",
            "pendingPaneReleases", "pendingWindowReleases", "surfaces",
        ]))
        XCTAssertEqual(requestPayload["allocationGenerationV1"] as? Bool, false)
        XCTAssertEqual(requestPayload["windowGenerationV1"] as? Bool, false)
        let pendingPaneReleases = try XCTUnwrap(requestPayload["pendingPaneReleases"] as? [[String: Any]])
        let pendingWindowReleases = try XCTUnwrap(requestPayload["pendingWindowReleases"] as? [[String: Any]])
        XCTAssertTrue(pendingPaneReleases.isEmpty)
        XCTAssertTrue(pendingWindowReleases.isEmpty)

        let legacyServer = Data(#"{"id":"register-1","op":"client.register","ok":true,"payload":{"clientId":"stable-client","registryIdentity":{"allocatorId":"alloc_home","fleetId":"fleet-home"},"surfaces":[]}}"#.utf8)
        let legacyReply = try SurfAceRegistrationWire.registration(
            from: legacyServer, requestId: "register-1", clientId: "stable-client",
            surfaces: [], expectedIdentity: expected
        )
        XCTAssertNil(legacyReply.projection.directEndpoint)
        XCTAssertFalse(legacyReply.projection.prePairDescribeV1)
        XCTAssertFalse(legacyReply.projection.allocationGenerationV1)
        XCTAssertNil(legacyReply.projection.endpointLease)
        XCTAssertEqual(legacyReply.projection.completedPaneReleaseIds, [])

        let reviewedRegistry = Data(#"{"id":"register-1","op":"client.register","ok":true,"payload":{"clientId":"stable-client","registryIdentity":{"allocatorId":"alloc_home","fleetId":"fleet-home"},"surfaces":[],"directEndpoint":null,"prePairDescribeV1":false,"allocationGenerationV1":false,"endpointLease":null,"completedPaneReleaseIds":[]}}"#.utf8)
        let reviewedReply = try SurfAceRegistrationWire.registration(
            from: reviewedRegistry, requestId: "register-1", clientId: "stable-client",
            surfaces: [], expectedIdentity: expected
        )
        XCTAssertEqual(reviewedReply.projection, legacyReply.projection)
        XCTAssertEqual(reviewedReply.assignments, [])
    }

    func testRegistrationProjectionRequiresMatchingEndpointAndLeaseCapability() throws {
        let expected = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        let endpoint = "wss://client.example/ws"
        let leasedResponse = Data(#"{"id":"register-1","op":"client.register","ok":true,"payload":{"clientId":"stable-client","registryIdentity":{"allocatorId":"alloc_home","fleetId":"fleet-home"},"surfaces":[],"directEndpoint":"wss://client.example/ws","prePairDescribeV1":true,"allocationGenerationV1":false,"endpointLease":{"leaseGeneration":41,"registrationObservedAtMs":1000,"leaseExpiresAtMs":2000},"completedPaneReleaseIds":[]}}"#.utf8)
        let reply = try SurfAceRegistrationWire.registration(
            from: leasedResponse, requestId: "register-1", clientId: "stable-client",
            surfaces: [], expectedIdentity: expected,
            expectedDirectEndpoint: endpoint, expectedPrePairDescribeV1: true
        )
        XCTAssertEqual(reply.projection.directEndpoint, endpoint)
        XCTAssertTrue(reply.projection.prePairDescribeV1)
        XCTAssertEqual(reply.projection.endpointLease, .init(
            leaseGeneration: 41, registrationObservedAtMs: 1000, leaseExpiresAtMs: 2000
        ))

        let unexpectedEndpoint = try SurfAceRegistrationWire.registration(
            from: leasedResponse, requestId: "register-1", clientId: "stable-client",
            surfaces: [], expectedIdentity: expected
        )
        XCTAssertNil(unexpectedEndpoint.projection.directEndpoint)
        XCTAssertTrue(unexpectedEndpoint.warnings.contains("registration_endpoint_capability_mismatch"))
        let mismatchedEndpoint = try SurfAceRegistrationWire.registration(
            from: leasedResponse, requestId: "register-1", clientId: "stable-client",
            surfaces: [], expectedIdentity: expected,
            expectedDirectEndpoint: "wss://other.example/ws", expectedPrePairDescribeV1: true
        )
        XCTAssertNil(mismatchedEndpoint.projection.directEndpoint)
        XCTAssertTrue(mismatchedEndpoint.warnings.contains("registration_endpoint_capability_mismatch"))
    }

    func testRegistrationAcceptsBothWindowGenerationFieldNamesAndContinuesWithoutGeneration() throws {
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        let expectedSurface = SurfAceRegistrationSurface(
            surfaceId: "sf_one",
            panes: [.init(paneId: "1", paneLineageId: "pl_sf_one_1", paneLabel: 0)]
        )

        func response(windowField: String) -> Data {
            Data("""
            {"id":"register-1","op":"client.register","ok":true,"payload":{
              "clientId":"stable-client",
              "registryIdentity":{"allocatorId":"alloc_home","fleetId":"fleet-home"},
              "allocationGenerationV1":true,"windowGenerationV1":true,
              "surfaces":[{"surfaceId":"sf_one","windowLabel":"b",\(windowField),
                "panes":[{"paneId":"1","paneLineageId":"pl_sf_one_1","paneLabel":1201,"allocationGeneration":41}]}]
            }}
            """.utf8)
        }

        for field in ["\"windowGeneration\":30", "\"windowAllocationGeneration\":30"] {
            let reply = try SurfAceRegistrationWire.registration(
                from: response(windowField: field), requestId: "register-1", clientId: "stable-client",
                surfaces: [expectedSurface], expectedIdentity: identity,
                expectedAllocationGenerationV1: true, expectedWindowGenerationV1: true
            )
            XCTAssertEqual(reply.assignments.first?.windowAllocationGeneration, 30)
            XCTAssertEqual(reply.assignments.first?.panes.first?.allocationGeneration, 41)
            XCTAssertFalse(reply.warnings.contains { $0.contains("generation_missing") })
        }

        let unrecognizedWindowGeneration = try SurfAceRegistrationWire.registration(
            from: response(windowField: "\"windowGeneration\":\"unknown\""),
            requestId: "register-1", clientId: "stable-client", surfaces: [expectedSurface],
            expectedIdentity: identity, expectedAllocationGenerationV1: true,
            expectedWindowGenerationV1: true
        )
        XCTAssertEqual(unrecognizedWindowGeneration.assignments.first?.windowLabel, "b")
        XCTAssertNil(unrecognizedWindowGeneration.assignments.first?.windowAllocationGeneration)
        XCTAssertTrue(unrecognizedWindowGeneration.warnings.contains(
            "registration_window_generation_unrecognized surface=sf_one"
        ))

        let missing = Data(#"{"id":"register-1","op":"client.register","ok":true,"payload":{"clientId":"stable-client","registryIdentity":{"allocatorId":"alloc_home","fleetId":"fleet-home"},"allocationGenerationV1":true,"windowGenerationV1":true,"surfaces":[{"surfaceId":"sf_one","windowLabel":"b","panes":[{"paneId":"1","paneLineageId":"pl_sf_one_1","paneLabel":1201}]}]}}"#.utf8)
        let reply = try SurfAceRegistrationWire.registration(
            from: missing, requestId: "register-1", clientId: "stable-client",
            surfaces: [expectedSurface], expectedIdentity: identity,
            expectedAllocationGenerationV1: true, expectedWindowGenerationV1: true
        )
        XCTAssertEqual(reply.assignments.first?.windowLabel, "b")
        XCTAssertNil(reply.assignments.first?.windowAllocationGeneration)
        XCTAssertEqual(reply.assignments.first?.panes.first?.paneLabel, 1201)
        XCTAssertTrue(reply.warnings.contains("registration_window_generation_missing surface=sf_one"))
        XCTAssertTrue(reply.warnings.contains("registration_pane_generation_missing surface=sf_one pane=1"))
    }

    func testRegistrationRejectsMalformedOrIncompleteEndpointLease() throws {
        let expected = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        let invalidPayloads = [
            #"{"directEndpoint":"wss://client.example/ws","prePairDescribeV1":true,"endpointLease":{"leaseGeneration":0,"registrationObservedAtMs":1000,"leaseExpiresAtMs":2000}}"#,
            #"{"directEndpoint":"wss://client.example/ws","prePairDescribeV1":true,"endpointLease":{"leaseGeneration":41,"registrationObservedAtMs":-1,"leaseExpiresAtMs":2000}}"#,
            #"{"directEndpoint":"wss://client.example/ws","prePairDescribeV1":true,"endpointLease":{"leaseGeneration":41,"registrationObservedAtMs":2000,"leaseExpiresAtMs":2000}}"#,
            #"{"directEndpoint":"wss://client.example/ws","prePairDescribeV1":true,"endpointLease":{"leaseGeneration":41,"registrationObservedAtMs":1000,"leaseExpiresAtMs":9007199254740992}}"#,
            #"{"directEndpoint":"wss://user:example@client.example/ws","prePairDescribeV1":true,"endpointLease":{"leaseGeneration":41,"registrationObservedAtMs":1000,"leaseExpiresAtMs":2000}}"#,
            #"{"directEndpoint":"wss://client.example/ws","prePairDescribeV1":true,"endpointLease":null}"#
        ]
        for payloadFields in invalidPayloads {
            let response = Data("""
            {"id":"register-1","op":"client.register","ok":true,"payload":{"clientId":"stable-client","registryIdentity":{"allocatorId":"alloc_home","fleetId":"fleet-home"},"surfaces":[],\(payloadFields.dropFirst().dropLast())}}
            """.utf8)
            let reply = try SurfAceRegistrationWire.registration(
                from: response, requestId: "register-1", clientId: "stable-client",
                surfaces: [], expectedIdentity: expected,
                expectedDirectEndpoint: "wss://client.example/ws", expectedPrePairDescribeV1: true
            )
            XCTAssertNil(reply.projection.directEndpoint)
            XCTAssertNil(reply.projection.endpointLease)
            XCTAssertTrue(reply.warnings.contains { $0.hasPrefix("registration_endpoint") })
        }
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
            let registryIdentity = try await connections[index].readRegistryIdentity()
            let assignments = try await connections[index].register(clientId: identity.clientId,
                surfaces: SurfAceRegistrationSurface.snapshot(state), expectedIdentity: registryIdentity)
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
            let registryIdentity = try await connection.readRegistryIdentity()
            let assignments = try await connection.register(clientId: identity.clientId,
                surfaces: SurfAceRegistrationSurface.snapshot(state), expectedIdentity: registryIdentity)
            XCTAssertEqual(assignments.first?.windowLabel, labels[index])
        }
        print("PRODUCTION_REGISTRATION clients=\(identities.map(\.clientId)) labels=\(labels) reconnect=PASS")
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

    func testRememberedTailnetEndpointPersistsReplacesAndClearsWhenBindingChanges() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remembered-endpoint-state-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let clientId = String(repeating: "a", count: 64)
        let home = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "home-fleet")
        let (store, adapter) = try await boundAdapter(at: root, clientId: clientId, identity: home)
        let first = "ws://100.101.102.103:19001/ws"
        let second = "ws://100.101.102.104:19001/ws"

        let firstStored = try await adapter.rememberTailnetEndpoint(first, registryIdentity: home, clientId: clientId)
        XCTAssertTrue(firstStored)
        let relaunched = try SurfAceLocklessRuntimeAdapter(store: store)
        let restored = await relaunched.snapshot()
        XCTAssertEqual(restored.rememberedTailnetEndpoint, .init(endpoint: first, registryIdentity: home))

        let replacementStored = try await relaunched.rememberTailnetEndpoint(second, registryIdentity: home, clientId: clientId)
        XCTAssertTrue(replacementStored)
        let replaced = await relaunched.snapshot()
        XCTAssertEqual(replaced.rememberedTailnetEndpoint, .init(endpoint: second, registryIdentity: home))

        let away = SurfAceRegistryIdentity(allocatorId: "alloc_away", fleetId: "away-fleet")
        _ = try await relaunched.bindRegistryIdentity(
            away, clientId: clientId, expectedSurfaces: [], allowRebinding: true
        )
        let rebound = await relaunched.snapshot()
        XCTAssertNil(rebound.rememberedTailnetEndpoint)
    }

    func testBonjourRegistrationStoresEndpointButConfiguredAndOlderRepliesDoNotReplaceIt() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remembered-endpoint-home-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let clientId = String(repeating: "b", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "home-fleet")
        let (_, adapter) = try await boundAdapter(at: root, clientId: clientId, identity: identity)
        let first = URL(string: "ws://100.101.102.103:19001/ws")!
        let homeURL = URL(string: "ws://home.example:19001/ws")!
        let homeTransport = Transport()
        homeTransport.registryIdentity = identity
        homeTransport.tailnetEndpoint = first
        let homeRegistration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: nil,
            discovered: [homeURL], transports: [homeURL: homeTransport]
        )

        try await homeRegistration.synchronize()
        XCTAssertEqual(homeRegistration.status, .connected)
        let homeState = await adapter.snapshot()
        XCTAssertEqual(homeState.rememberedTailnetEndpoint, .init(
            endpoint: first.absoluteString, registryIdentity: identity
        ))
        homeRegistration.stop()

        let laterTailnet = URL(string: "ws://100.101.102.104:19001/ws")!
        let laterHomeURL = URL(string: "ws://later-home.example:19001/ws")!
        let laterHomeTransport = Transport()
        laterHomeTransport.registryIdentity = identity
        laterHomeTransport.tailnetEndpoint = laterTailnet
        let laterHomeRegistration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: nil,
            discovered: [laterHomeURL], transports: [laterHomeURL: laterHomeTransport]
        )
        try await laterHomeRegistration.synchronize()
        let replacedByHome = await adapter.snapshot()
        XCTAssertEqual(replacedByHome.rememberedTailnetEndpoint?.endpoint, laterTailnet.absoluteString)
        laterHomeRegistration.stop()

        let configuredURL = URL(string: "ws://configured.example:19001/ws")!
        let configuredTransport = Transport()
        configuredTransport.registryIdentity = identity
        configuredTransport.tailnetEndpoint = URL(string: "ws://100.101.102.105:19001/ws")!
        let configuredRegistration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: configuredURL,
            discovered: [], transports: [configuredURL: configuredTransport]
        )
        try await configuredRegistration.synchronize()
        XCTAssertEqual(configuredRegistration.status, .connected)
        let configuredState = await adapter.snapshot()
        XCTAssertEqual(configuredState.rememberedTailnetEndpoint?.endpoint, laterTailnet.absoluteString)
        configuredRegistration.stop()

        let olderPeerURL = URL(string: "ws://older.example:19001/ws")!
        let olderPeer = Transport()
        olderPeer.registryIdentity = identity
        let olderPeerRegistration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: nil,
            discovered: [olderPeerURL], transports: [olderPeerURL: olderPeer]
        )
        try await olderPeerRegistration.synchronize()
        XCTAssertEqual(olderPeerRegistration.status, .connected)
        let olderPeerState = await adapter.snapshot()
        XCTAssertEqual(olderPeerState.rememberedTailnetEndpoint?.endpoint, laterTailnet.absoluteString)
        olderPeerRegistration.stop()
    }

    func testSuccessfulConfiguredAddressDoesNotTryRememberedEndpoint() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remembered-endpoint-configured-success-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let clientId = String(repeating: "a", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "home-fleet")
        let rememberedValue = "ws://100.101.102.103:19001/ws"
        let (_, adapter) = try await boundAdapter(
            at: root, clientId: clientId, identity: identity, rememberedEndpoint: rememberedValue
        )
        let configuredURL = URL(string: "ws://configured.example:19001/ws")!
        let rememberedURL = try XCTUnwrap(SurfAceTailnetEndpoint.url(from: rememberedValue))
        let configured = Transport()
        configured.registryIdentity = identity
        configured.tailnetEndpoint = URL(string: "ws://100.101.102.104:19001/ws")!
        let remembered = Transport()
        remembered.registryIdentity = identity
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: configuredURL,
            discovered: [], transports: [configuredURL: configured, rememberedURL: remembered]
        )

        try await registration.synchronize()

        XCTAssertEqual(registration.status, .connected)
        XCTAssertEqual(configured.registrationCount, 1)
        XCTAssertEqual(remembered.identityReads, 0)
        XCTAssertEqual(remembered.registrationCount, 0)
        let state = await adapter.snapshot()
        XCTAssertEqual(state.rememberedTailnetEndpoint?.endpoint, rememberedValue)
        registration.stop()
    }

    func testRememberedEndpointRunsAfterEmptyBonjourAndConfiguredFailure() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remembered-endpoint-order-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let clientId = String(repeating: "c", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "home-fleet")
        let rememberedValue = "ws://100.101.102.103:19001/ws"
        let (_, adapter) = try await boundAdapter(
            at: root, clientId: clientId, identity: identity, rememberedEndpoint: rememberedValue
        )
        let configuredURL = URL(string: "ws://configured.example:19001/ws")!
        let rememberedURL = try XCTUnwrap(SurfAceTailnetEndpoint.url(from: rememberedValue))
        let configuredTransport = Transport()
        configuredTransport.registryIdentity = identity
        configuredTransport.fails = true
        let rememberedTransport = Transport()
        rememberedTransport.registryIdentity = identity
        rememberedTransport.tailnetEndpoint = URL(string: "ws://100.101.102.104:19001/ws")!
        var events: [String] = []
        configuredTransport.onIdentityRead = { events.append("configured.identity") }
        configuredTransport.onRegister = { events.append("configured.register") }
        rememberedTransport.onIdentityRead = { events.append("remembered.identity") }
        rememberedTransport.onRegister = { events.append("remembered.register") }

        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: configuredURL,
            discovered: [], transports: [configuredURL: configuredTransport, rememberedURL: rememberedTransport]
        )
        try await registration.synchronize()

        XCTAssertEqual(events, [
            "configured.identity", "configured.register", "remembered.identity", "remembered.register"
        ])
        XCTAssertEqual(configuredTransport.registrationCount, 1)
        XCTAssertEqual(rememberedTransport.registrationCount, 1)
        XCTAssertEqual(registration.status, .connected)
        let state = await adapter.snapshot()
        XCTAssertEqual(state.rememberedTailnetEndpoint?.endpoint, rememberedValue)
        registration.stop()
    }

    func testRememberedEndpointIsNotTriedWhenBonjourFindsAServer() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remembered-endpoint-discovery-wins-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let clientId = String(repeating: "f", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "home-fleet")
        let rememberedValue = "ws://100.101.102.103:19001/ws"
        let (_, adapter) = try await boundAdapter(
            at: root, clientId: clientId, identity: identity, rememberedEndpoint: rememberedValue
        )
        let discoveredURL = URL(string: "ws://home.example:19001/ws")!
        let rememberedURL = try XCTUnwrap(SurfAceTailnetEndpoint.url(from: rememberedValue))
        let discovered = Transport()
        discovered.registryIdentity = identity
        discovered.fails = true
        let remembered = Transport()
        remembered.registryIdentity = identity
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: nil,
            discovered: [discoveredURL],
            transports: [discoveredURL: discovered, rememberedURL: remembered]
        )

        do {
            try await registration.synchronize()
            XCTFail("a failed Bonjour candidate fell through to the remembered endpoint")
        } catch { }

        XCTAssertEqual(discovered.registrationCount, 1)
        XCTAssertEqual(remembered.identityReads, 0)
        XCTAssertEqual(remembered.registrationCount, 0)
        XCTAssertEqual(registration.status, .disconnected)
        let state = await adapter.snapshot()
        XCTAssertEqual(state.rememberedTailnetEndpoint?.endpoint, rememberedValue)
    }

    func testRememberedEndpointIdentityMismatchDoesNotRegisterOrDiscardAddress() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remembered-endpoint-mismatch-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let clientId = String(repeating: "d", count: 64)
        let current = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "home-fleet")
        let rememberedValue = "ws://100.101.102.103:19001/ws"
        let (_, adapter) = try await boundAdapter(
            at: root, clientId: clientId, identity: current, rememberedEndpoint: rememberedValue
        )
        let endpoint = try XCTUnwrap(SurfAceTailnetEndpoint.url(from: rememberedValue))
        let other = Transport()
        other.registryIdentity = SurfAceRegistryIdentity(allocatorId: "alloc_other", fleetId: "other-fleet")
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: nil,
            discovered: [], transports: [endpoint: other]
        )

        do {
            try await registration.synchronize()
            XCTFail("an endpoint for another registry connected")
        } catch { }

        XCTAssertEqual(registration.status, .disconnected)
        XCTAssertEqual(other.registrationCount, 0)
        let state = await adapter.snapshot()
        XCTAssertEqual(state.rememberedTailnetEndpoint?.endpoint, rememberedValue)
    }

    func testRememberedEndpointFailureKeepsAddressForTheExistingRetry() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("remembered-endpoint-retry-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: root) }
        let clientId = String(repeating: "e", count: 64)
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "home-fleet")
        let rememberedValue = "ws://100.101.102.103:19001/ws"
        let (_, adapter) = try await boundAdapter(
            at: root, clientId: clientId, identity: identity, rememberedEndpoint: rememberedValue
        )
        let endpoint = try XCTUnwrap(SurfAceTailnetEndpoint.url(from: rememberedValue))
        let transport = Transport()
        transport.registryIdentity = identity
        transport.fails = true
        transport.tailnetEndpoint = URL(string: "ws://100.101.102.104:19001/ws")!
        let registration = centralRegistration(
            adapter: adapter, clientId: clientId, configured: nil,
            discovered: [], transports: [endpoint: transport]
        )

        do {
            try await registration.synchronize()
            XCTFail("failed remembered registration connected")
        } catch { }
        XCTAssertEqual(registration.status, .disconnected)
        let failedState = await adapter.snapshot()
        XCTAssertEqual(failedState.rememberedTailnetEndpoint?.endpoint, rememberedValue)

        transport.fails = false
        try await registration.synchronize()
        XCTAssertEqual(registration.status, .connected)
        XCTAssertEqual(transport.registrationCount, 2)
        let retriedState = await adapter.snapshot()
        XCTAssertEqual(retriedState.rememberedTailnetEndpoint?.endpoint, rememberedValue)
        registration.stop()
    }

    func testRegistrationTailnetEndpointIsOptionalAndMalformedValuesAreIgnored() throws {
        let identity = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "home-fleet")
        func parse(_ optionalField: String) throws -> SurfAceRegistrationReply {
            let response = Data("""
            {"id":"register-1","op":"client.register","type":"response","v":1,"ok":true,"payload":{"clientId":"client","registryIdentity":{"allocatorId":"alloc_home","fleetId":"home-fleet"},"surfaces":[]\(optionalField)}}
            """.utf8)
            return try SurfAceRegistrationWire.registration(
                from: response, requestId: "register-1", clientId: "client", surfaces: [],
                expectedIdentity: identity
            )
        }

        let valid = try parse(",\"tailnetEndpoint\":\"ws://100.101.102.103:19001/ws\"")
        XCTAssertEqual(valid.reportedRegistryIdentity, identity)
        XCTAssertEqual(valid.tailnetEndpoint?.absoluteString, "ws://100.101.102.103:19001/ws")
        XCTAssertFalse(valid.discarded)

        let absent = try parse("")
        XCTAssertNil(absent.tailnetEndpoint)
        XCTAssertFalse(absent.discarded)

        let malformedType = try parse(",\"tailnetEndpoint\":42")
        XCTAssertNil(malformedType.tailnetEndpoint)
        XCTAssertTrue(malformedType.warnings.contains("registration_tailnet_endpoint_unrecognized"))
        XCTAssertFalse(malformedType.discarded)

        let invalidHost = try parse(",\"tailnetEndpoint\":\"ws://registry.example:19001/ws\"")
        XCTAssertNil(invalidHost.tailnetEndpoint)
        XCTAssertTrue(invalidHost.warnings.contains("registration_tailnet_endpoint_unrecognized"))
        XCTAssertFalse(invalidHost.discarded)
    }
}
