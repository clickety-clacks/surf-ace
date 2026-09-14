import Foundation
import XCTest
@testable import SurfAce

@MainActor
final class SurfAceCentralDiscoveryTests: XCTestCase {
    private final class Browser: NetServiceBrowser {
        var started = false
        var stops = 0
        override func searchForServices(ofType type: String, inDomain domain: String) { started = true }
        override func stop() { stops += 1 }
    }
    private final class Service: NetService {
        var timeout: TimeInterval?
        var stopped = false
        override var hostName: String? { "racter." }
        override func txtRecordData() -> Data? {
            NetService.data(fromTXTRecord: ["role": Data("server".utf8), "ws": Data("/ws".utf8)])
        }
        override func resolve(withTimeout timeout: TimeInterval) { self.timeout = timeout }
        override func stop() { stopped = true }
    }
    @MainActor
    private final class Clock {
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
    private func until(_ ready: () -> Bool) async {
        for _ in 0..<10000 {
            if ready() { return }
            await Task.yield()
        }
        XCTFail("expected callback checkpoint")
    }
    private func service() -> Service {
        Service(domain: "local.", type: "_surf-ace._tcp.", name: "owned", port: 43867)
    }

    func testLateResolutionSurvivesBrowseWindowAndNormalizesEndpoint() async {
        let browser = Browser(), clock = Clock(), service = service()
        let discovery = SurfAceCentralDiscovery(browser: browser, sleep: { try await clock.sleep($0) })
        let result = Task { await discovery.discover() }
        await until { browser.started && clock.calls == 1 }
        discovery.netServiceBrowser(browser, didFind: service, moreComing: false)
        XCTAssertEqual(service.timeout, 5)
        clock.permits += 1
        await until { clock.calls == 2 }
        XCTAssertFalse(service.stopped)
        discovery.netServiceDidResolveAddress(service)
        let urls = await result.value
        XCTAssertEqual(urls, [URL(string: "ws://racter:43867/ws")!])
        XCTAssertTrue(service.stopped)
    }

    func testResolverErrorCompletesAndNextDiscoveryCanRetry() async {
        let browser = Browser(), clock = Clock(), service = service()
        let discovery = SurfAceCentralDiscovery(browser: browser, sleep: { try await clock.sleep($0) })
        let first = Task { await discovery.discover() }
        await until { clock.calls == 1 }
        discovery.netServiceBrowser(browser, didFind: service, moreComing: false)
        discovery.netService(service, didNotResolve: ["NSNetServicesErrorCode": -72007])
        clock.permits += 1
        let empty = await first.value
        XCTAssertTrue(empty.isEmpty)
        let secondService = self.service()
        let second = Task { await discovery.discover() }
        await until { clock.calls == 2 }
        discovery.netServiceBrowser(browser, didFind: secondService, moreComing: false)
        discovery.netServiceDidResolveAddress(secondService)
        clock.permits += 1
        let urls = await second.value
        XCTAssertEqual(urls.count, 1)
    }

    func testMissingResolverCallbackHasBoundedDeadlineAndIgnoresLateResult() async {
        let browser = Browser(), clock = Clock(), service = service()
        let discovery = SurfAceCentralDiscovery(browser: browser, sleep: { try await clock.sleep($0) })
        let task = Task { await discovery.discover() }
        await until { clock.calls == 1 }
        discovery.netServiceBrowser(browser, didFind: service, moreComing: false)
        clock.permits += 1
        await until { clock.calls == 2 }
        clock.permits += 1
        let urls = await task.value
        XCTAssertTrue(urls.isEmpty)
        XCTAssertTrue(service.stopped)
        discovery.netServiceDidResolveAddress(service)
        XCTAssertTrue(discovery.transportURLs(for: URL(string: "ws://racter:43867/ws")!).isEmpty)
    }

    func testBrowseFailureAndCallerCancellationComplete() async {
        let browser = Browser(), clock = Clock()
        let discovery = SurfAceCentralDiscovery(browser: browser, sleep: { try await clock.sleep($0) })
        let first = Task { await discovery.discover() }
        await until { clock.calls == 1 }
        discovery.netServiceBrowser(browser, didNotSearch: ["NSNetServicesErrorCode": -72000])
        let urls = await first.value
        XCTAssertTrue(urls.isEmpty)
        let next = Task { await discovery.discover() }
        await until { clock.calls == 2 }
        next.cancel()
        let canceled = await next.value
        XCTAssertTrue(canceled.isEmpty)
    }

    func testEndpointKeepsHostPortPathWithoutBroadSecurityChange() {
        XCTAssertEqual(SurfAceCentralDiscovery.endpoint(host: "racter.", port: 43867, path: "/"), URL(string: "ws://racter:43867/"))
        XCTAssertEqual(SurfAceCentralDiscovery.endpoint(host: "eezo.local.", port: 19002, path: "/ws"), URL(string: "ws://eezo.local:19002/ws"))
        XCTAssertEqual(SurfAceCentralDiscovery.endpoint(host: "example.com.", port: 80, path: "/"), URL(string: "ws://example.com:80/"))
        XCTAssertNil(SurfAceCentralDiscovery.endpoint(host: ".", port: 80, path: "/"))
        XCTAssertNil(SurfAceCentralDiscovery.endpoint(host: "racter.", port: 0, path: "/"))
        XCTAssertNil(SurfAceCentralDiscovery.endpoint(host: "racter.", port: 65536, path: "/"))
        XCTAssertNil(SurfAceCentralDiscovery.endpoint(host: "racter.", port: 43867, path: "bad"))
    }
}
