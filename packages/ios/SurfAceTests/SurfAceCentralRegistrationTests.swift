import CryptoKit
import Darwin
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
        var assignsPaneLabels = false
        var registeredSurfaces: [SurfAceRegistrationSurface] = []
        var nextPaneLabel: Int64 = 700
        var registryIdentity = SurfAceRegistryIdentity(allocatorId: "alloc_fixture", fleetId: "fixture-fleet")
        var identityReads = 0
        func readRegistryIdentity() async throws -> SurfAceRegistryIdentity {
            identityReads += 1
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
        var resolvedHost = "racter."
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

    private func discoveryService(name: String = "owned", host: String = "racter.") -> DiscoveryService {
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
        XCTAssertTrue(discovery.transportURLs(for: URL(string: "ws://racter:43867/")!).isEmpty)

        let cancelledService = discoveryService(name: "cancelled")
        let cancelled = Task { await discovery.discover() }
        await until { secondBrowser.started }
        discovery.netServiceBrowser(secondBrowser, didFind: cancelledService, moreComing: false)
        cancelled.cancel()
        let cancelledURLs = await cancelled.value
        XCTAssertTrue(cancelledURLs.isEmpty)
        discovery.netServiceDidResolveAddress(cancelledService)
        discovery.netService(cancelledService, didNotResolve: [:])
        XCTAssertTrue(discovery.transportURLs(for: URL(string: "ws://racter:43867/")!).isEmpty)
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
        XCTAssertEqual(secondURLs, [URL(string: "ws://racter:43867/ws")!])
        discovery.netServiceDidResolveAddress(current)
        XCTAssertTrue(current.stopped)
    }

    func testDiscoveredLocalHostNormalizationMatchesConfiguredRacterURL() throws {
        let discovered = try XCTUnwrap(
            SurfAceCentralDiscovery.localTransportURL(host: "racter.", port: 43867, path: "/ws")
        )
        XCTAssertEqual(discovered, URL(string: "ws://racter:43867/ws"))

        let discoveredLocal = try XCTUnwrap(
            SurfAceCentralDiscovery.localTransportURL(host: "racter.local.", port: 43867, path: "/socket")
        )
        XCTAssertEqual(discoveredLocal, URL(string: "ws://racter.local:43867/socket"))
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
        let hostname = try XCTUnwrap(URL(string: "ws://racter:43867/"))
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

    func testConfiguredLocalNumericSuccessRemainsPinnedAndSkipsDiscovery() async throws {
        let configured = try XCTUnwrap(URL(string: "ws://100.64.12.34:43867/"))
        let transport = Transport()
        var attempted: [URL] = []
        let registration = SurfAceCentralRegistration(
            clientId: "numeric-client",
            configured: configured,
            discover: { XCTFail("a successful configured numeric controller must not discover another controller"); return [] },
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
        let discovered = try XCTUnwrap(URL(string: "ws://racter:43867/"))
        let primary = Transport()
        primary.fails = true
        primary.label = "configured"
        let fallback = Transport()
        fallback.label = "bonjour"
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
            discover: { XCTFail("configured success must not discover"); return [] },
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
        try await registration.synchronize()
        XCTAssertEqual(registration.status, .connected)
        XCTAssertEqual(statuses.count, count)
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

    func testEmptyStartupNeverPublishesConnected() async throws {
        var statuses: [SurfAceCentralRegistrationStatus] = []
        let registration = SurfAceCentralRegistration(clientId: "test", configured: nil,
            discover: { XCTFail("empty surface discovery"); return [] },
            snapshot: { [] }, apply: { _, _ in XCTFail("empty registration") }, verifyRegistry: { _, _ in },
            onStatusChange: { statuses.append($0) })
        try await registration.synchronize()
        XCTAssertEqual(registration.status, .disconnected)
        XCTAssertFalse(statuses.contains(.connected))
        registration.stop()
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

        XCTAssertThrowsError(try SurfAceRegistrationWire.paneClaimLabel(
            from: response, requestId: "claim-rejected"
        )) { error in
            guard case let SurfAceRegistrationError.paneClaimRejected(code, message) = error else {
                XCTFail("server rejection was not retained")
                return
            }
            XCTAssertNil(code)
            XCTAssertNil(message)
        }

        XCTAssertFalse(isPaneAllocatorUnavailable(SurfAceRegistrationError.stopped))
        XCTAssertFalse(isPaneAllocatorUnavailable(SurfAceRegistrationError.topologyChanged))

        let malformedSuccess = Data(#"{"id":"claim-malformed","op":"pane.claim","ok":true,"payload":{}}"#.utf8)
        XCTAssertThrowsError(try SurfAceRegistrationWire.paneClaimLabel(
            from: malformedSuccess, requestId: "claim-malformed"
        )) { error in
        XCTAssertFalse(isPaneAllocatorUnavailable(error))
        }
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

    func testLegacyBindingRejectsForeignBeforeRegistrationAndPersistsForRestart() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-binding-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        let id = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(
            state: &state, expectedSurfaceSetRevision: 0
        ).surface.surfaceId
        try SurfAceLocklessTopologyOperations.applyWindowLabels(state: &state, assignments: [(id, "z")])
        state.liveSurfaces[id]?.panes["1"]?.paneLabel = 700
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let clientId = "legacy-client"
        let home = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        let foreign = SurfAceRegistryIdentity(allocatorId: "alloc_foreign", fleetId: "fleet-foreign")
        let replacedAllocator = SurfAceRegistryIdentity(allocatorId: "alloc_replaced", fleetId: "fleet-home")
        let provisioning = SurfAceProvisionedRegistryBinding(
            binding: .init(allocatorId: home.allocatorId, clientId: clientId, fleetId: home.fleetId),
            confirmedClaims: SurfAceProvisionedRegistryBinding.confirmedClaims(state)
        )
        let surfaces = SurfAceRegistrationSurface.snapshot(state)
        do {
            try await adapter.bindRegistryIdentity(foreign, clientId: clientId,
                expectedSurfaces: surfaces, provisioned: nil)
            XCTFail("legacy state accepted discovery without provisioning")
        } catch { }
        let pending = await adapter.snapshot()
        XCTAssertNil(pending.registryBinding)
        do {
            try await adapter.bindRegistryIdentity(foreign, clientId: clientId,
                expectedSurfaces: surfaces, provisioned: provisioning)
            XCTFail("legacy state accepted foreign fleet")
        } catch { }
        do {
            try await adapter.bindRegistryIdentity(replacedAllocator, clientId: clientId,
                expectedSurfaces: surfaces, provisioned: provisioning)
            XCTFail("legacy state accepted a different allocator under the same fleet")
        } catch { }
        try await adapter.bindRegistryIdentity(home, clientId: clientId,
            expectedSurfaces: surfaces, provisioned: provisioning)
        XCTAssertEqual(try XCTUnwrap(store.load()).registryBinding, provisioning.binding)
        let restored = try SurfAceLocklessRuntimeAdapter(store: store)
        do {
            try await restored.bindRegistryIdentity(foreign, clientId: clientId,
                expectedSurfaces: surfaces, provisioned: nil)
            XCTFail("restart forgot registry binding")
        } catch { }
        let afterRestart = await restored.snapshot()
        XCTAssertEqual(afterRestart.liveSurfaces[id]?.panes["1"]?.paneLabel, 700)
    }

    func testBindingReadbackReconcilesCommittedDiskCandidateBeforeForeignRetry() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("registry-readback-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let store = SurfAceLocklessGenerationStore(stateURL: root.appendingPathComponent("state.json"))
        var state = try SurfAceLocklessAuthorityState.empty()
        _ = try SurfAceLocklessTopologyOperations.surfaceWindowOpen(state: &state, expectedSurfaceSetRevision: 0)
        try store.save(state)
        let adapter = try SurfAceLocklessRuntimeAdapter(store: store)
        let before = await adapter.snapshot()
        let surfaces = SurfAceRegistrationSurface.snapshot(before)
        let home = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        let foreign = SurfAceRegistryIdentity(allocatorId: "alloc_foreign", fleetId: "fleet-foreign")
        let binding = SurfAceRegistryBinding(allocatorId: home.allocatorId,
                                              clientId: "readback-client", fleetId: home.fleetId)
        var committed = before
        committed.registryBinding = binding
        committed.generation += 1
        try store.save(committed)
        do {
            try await adapter.bindRegistryIdentity(foreign, clientId: "readback-client",
                expectedSurfaces: surfaces, provisioned: nil)
            XCTFail("foreign identity replaced ambiguous committed candidate")
        } catch { }
        let afterReadback = await adapter.snapshot()
        XCTAssertEqual(afterReadback.registryBinding, binding)
        try await adapter.bindRegistryIdentity(home, clientId: "readback-client",
            expectedSurfaces: surfaces, provisioned: nil)
        XCTAssertEqual(try XCTUnwrap(store.load()).registryBinding, binding)
    }

    func testTwoRegistryRouteChecksIdentityBeforeRegistration() async throws {
        let foreignURL = URL(string: "ws://127.0.0.1:24001/ws")!
        let homeURL = URL(string: "ws://127.0.0.1:24002/ws")!
        let foreign = Transport()
        foreign.registryIdentity = .init(allocatorId: "alloc_foreign", fleetId: "fleet-foreign")
        let home = Transport()
        home.registryIdentity = .init(allocatorId: "alloc_home", fleetId: "fleet-home")
        let expected = home.registryIdentity
        let registration = SurfAceCentralRegistration(
            clientId: "stable-client", configured: foreignURL,
            discover: { [homeURL] },
            makeTransport: { $0 == foreignURL ? foreign : home },
            snapshot: { [.init(surfaceId: "sf_one", panes: [])] },
            apply: { _, _ in },
            verifyRegistry: { identity, _ in
                guard identity == expected else { throw SurfAceRegistrationError.foreignRegistryIdentity }
            }
        )
        try await registration.synchronize()
        XCTAssertEqual(foreign.identityReads, 1)
        XCTAssertTrue(foreign.clients.isEmpty)
        XCTAssertEqual(home.clients, ["stable-client"])
        XCTAssertEqual(registration.status, .connected)
        registration.stop()
    }

    func testRegistryIdentityWireRejectsMissingAndMismatchedResponses() throws {
        let valid = Data(#"{"id":"identity-1","op":"fleet.topology","type":"response","v":1,"ok":true,"payload":{"registryIdentity":{"allocatorId":"alloc_home","fleetId":"fleet-home"}}}"#.utf8)
        XCTAssertEqual(try SurfAceRegistrationWire.registryIdentity(from: valid, requestId: "identity-1"),
                       .init(allocatorId: "alloc_home", fleetId: "fleet-home"))
        let missing = Data(#"{"id":"identity-1","op":"fleet.topology","type":"response","v":1,"ok":true,"payload":{}}"#.utf8)
        XCTAssertThrowsError(try SurfAceRegistrationWire.registryIdentity(from: missing, requestId: "identity-1"))
        XCTAssertThrowsError(try SurfAceRegistrationWire.registryIdentity(from: valid, requestId: "different"))
    }

    func testRegistrationResponseIdentityMustMatchPreflightBeforeLabelsApply() throws {
        let expected = SurfAceRegistryIdentity(allocatorId: "alloc_home", fleetId: "fleet-home")
        let matching = Data(#"{"id":"register-1","op":"client.register","ok":true,"payload":{"clientId":"stable-client","registryIdentity":{"allocatorId":"alloc_home","fleetId":"fleet-home"},"surfaces":[]}}"#.utf8)
        XCTAssertEqual(try SurfAceRegistrationWire.assignments(
            from: matching, requestId: "register-1", clientId: "stable-client",
            surfaces: [], expectedIdentity: expected
        ), [])
        let foreign = Data(#"{"id":"register-1","op":"client.register","ok":true,"payload":{"clientId":"stable-client","registryIdentity":{"allocatorId":"alloc_foreign","fleetId":"fleet-foreign"},"surfaces":[]}}"#.utf8)
        let missing = Data(#"{"id":"register-1","op":"client.register","ok":true,"payload":{"clientId":"stable-client","surfaces":[]}}"#.utf8)
        for response in [foreign, missing] {
            XCTAssertThrowsError(try SurfAceRegistrationWire.assignments(
                from: response, requestId: "register-1", clientId: "stable-client",
                surfaces: [], expectedIdentity: expected
            ))
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
}
