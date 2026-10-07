import Network
import XCTest
@testable import SurfAce

final class SurfAceHTTPServerTests: XCTestCase {
    func testFixedPortConstantIs19001() {
        XCTAssertEqual(SurfAceHTTPServer.fixedPort, 19_001)
    }

    func testIsolatedLoopbackUsesOSAssignedPort() async throws {
        let server = SurfAceHTTPServer()
        let port = try await server.startIsolatedLoopbackForTesting(
            httpHandler: { _ in HTTPServerResponse.empty(statusCode: 200) },
            webSocketHandler: { _ in }
        )

        XCTAssertNotEqual(port, 0)
        XCTAssertNotEqual(port, SurfAceHTTPServer.fixedPort)
        await server.stop()
    }

    func testStartForTestingRejectsEphemeralPortRequest() async {
        let server = SurfAceHTTPServer()

        do {
            _ = try await server.startForTesting(
                port: 0,
                httpHandler: { _ in HTTPServerResponse.empty(statusCode: 200) },
                webSocketHandler: { _ in }
            )
            XCTFail("Expected fixed-port validation to reject ephemeral binding")
        } catch let error as SurfAceHTTPServerError {
            guard case .invalidRequestedPort(0) = error else {
                XCTFail("Unexpected server error: \(error)")
                return
            }
        } catch {
            XCTFail("Unexpected error type: \(error)")
        }
    }

    func testIsolatedHostRejectsFixedPortBeforeBinding() async {
        guard requireIsolatedTestPlan() else { return }
        let server = SurfAceHTTPServer()

        do {
            _ = try await server.startForTesting(
                port: SurfAceHTTPServer.fixedPort,
                httpHandler: { _ in HTTPServerResponse.empty(statusCode: 200) },
                webSocketHandler: { _ in }
            )
            XCTFail("Isolated XCTest host must reject a fixed port before binding")
        } catch SurfAceHTTPServerError.fixedPortUnavailableInIsolatedTestHost {
        } catch {
            XCTFail("Unexpected fixed-port rejection error: \(error)")
        }
    }

    func testOSAssignedLoopbackPortAvoidsWildcardIncumbent() async throws {
        guard requireIsolatedTestPlan() else { return }

        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        parameters.requiredInterfaceType = .loopback
        parameters.requiredLocalEndpoint = .hostPort(
            host: .ipv4(try XCTUnwrap(IPv4Address("0.0.0.0"))),
            port: .any
        )
        let wildcardListener = try NWListener(using: parameters)
        let wildcardReady = expectation(description: "wildcard listener restricted to loopback is ready")
        wildcardListener.newConnectionHandler = { $0.cancel() }
        wildcardListener.stateUpdateHandler = { state in
            switch state {
            case .ready:
                wildcardReady.fulfill()
            case .failed(let error):
                XCTFail("Loopback-restricted wildcard fixture failed: \(error)")
                wildcardReady.fulfill()
            default:
                break
            }
        }
        wildcardListener.start(queue: DispatchQueue(label: "SurfAceTests.wildcardLoopback"))
        defer { wildcardListener.cancel() }
        await fulfillment(of: [wildcardReady], timeout: 5)
        let port = try XCTUnwrap(wildcardListener.port?.rawValue)

        let contender = SurfAceHTTPServer()
        do {
            _ = try await contender.startForTesting(
                port: port,
                httpHandler: { _ in HTTPServerResponse.empty(statusCode: 200) },
                webSocketHandler: { _ in }
            )
            XCTFail("Isolated XCTest host must reject the wildcard incumbent's fixed port")
        } catch SurfAceHTTPServerError.fixedPortUnavailableInIsolatedTestHost {
        } catch {
            XCTFail("Unexpected fixed-port rejection error: \(error)")
        }

        let assignedPort = try await contender.startIsolatedLoopbackForTesting(
            httpHandler: { _ in HTTPServerResponse.empty(statusCode: 200) },
            webSocketHandler: { _ in }
        )
        XCTAssertNotEqual(assignedPort, port)
        await contender.stop()
    }

    func testIsolatedHostRejectsFixedPortFallbackBeforeBinding() async {
        guard requireIsolatedTestPlan() else { return }
        let server = SurfAceHTTPServer()

        do {
            _ = try await server.startWithFallbackForTesting(
                preferredPort: SurfAceHTTPServer.fixedPort,
                fallbackPortOffsetLimit: SurfAceHTTPServer.fallbackPortOffsetLimit,
                httpHandler: { _ in HTTPServerResponse.empty(statusCode: 200) },
                webSocketHandler: { _ in }
            )
            XCTFail("Isolated XCTest host must reject fixed-port fallback before binding")
        } catch SurfAceHTTPServerError.fixedPortUnavailableInIsolatedTestHost {
        } catch {
            XCTFail("Unexpected fixed-port fallback error: \(error)")
        }
    }

    @MainActor
    func testRuntimeInitializationUsesDeviceNameWithoutBlockingHostResolution() throws {
        let runtimeSourceURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("SurfAce/SurfAceRuntime.swift")
        let source = try String(contentsOf: runtimeSourceURL, encoding: .utf8)
        let initializationStart = try XCTUnwrap(
            source.range(of: "    init(\n        userDefaults: UserDefaults = .standard")?.lowerBound
        )
        let initializationEnd = try XCTUnwrap(
            source.range(of: "\n    func start() async", range: initializationStart..<source.endIndex)?.lowerBound
        )
        let initializationSource = source[initializationStart..<initializationEnd]

        XCTAssertFalse(initializationSource.contains("ProcessInfo.processInfo.hostName"))
        XCTAssertFalse(initializationSource.contains("NSHost"))

        let suiteName = "SurfAceHostnameWatchdogTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suiteName))
        defer { defaults.removePersistentDomain(forName: suiteName) }
        let runtime = SurfAceRuntime(userDefaults: defaults)
        XCTAssertEqual(runtime.screenName, "Surf Ace - \(UIDevice.current.name)")
    }

    func testInfoPlistDeclaresLocalNetworkPrivacyUsage() throws {
        let info = try loadAppInfoPlist()
        let usageDescription = try XCTUnwrap(info["NSLocalNetworkUsageDescription"] as? String)
        XCTAssertFalse(usageDescription.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    func testInfoPlistAllowsOnlyLocalNetworkTransport() throws {
        let info = try loadAppInfoPlist()
        let transportSecurity = try XCTUnwrap(info["NSAppTransportSecurity"] as? [String: Any])

        XCTAssertEqual(Set(transportSecurity.keys), Set(["NSAllowsLocalNetworking"]))
        XCTAssertEqual(transportSecurity["NSAllowsLocalNetworking"] as? Bool, true)
    }

    func testInfoPlistDeclaresSurfAceBonjourServiceType() throws {
        let info = try loadAppInfoPlist()
        let services = try XCTUnwrap(info["NSBonjourServices"] as? [String])
        XCTAssertEqual(services, ["_surf-ace._tcp"])
    }

    func testInfoPlistDeclaresMultipleSceneSupport() throws {
        let info = try loadAppInfoPlist()
        let sceneManifest = try XCTUnwrap(info["UIApplicationSceneManifest"] as? [String: Any])
        XCTAssertEqual(sceneManifest["UIApplicationSupportsMultipleScenes"] as? Bool, true)
    }

    func testInfoPlistDeclaresLaunchStoryboardForFullResolutionIPadSizing() throws {
        let info = try loadAppInfoPlist()
        XCTAssertEqual(info["UILaunchStoryboardName"] as? String, "LaunchScreen")
    }

    func testInfoPlistRequiresFullScreenForDeviceWidthIPadSizing() throws {
        let info = try loadAppInfoPlist()
        XCTAssertEqual(info["UIRequiresFullScreen"] as? Bool, true)
    }

    func testInfoPlistDeclaresAllIPadOrientationsForLandscapeAndPortraitScenes() throws {
        let info = try loadAppInfoPlist()
        let orientations = try XCTUnwrap(info["UISupportedInterfaceOrientations~ipad"] as? [String])
        XCTAssertEqual(
            Set(orientations),
            [
                "UIInterfaceOrientationPortrait",
                "UIInterfaceOrientationPortraitUpsideDown",
                "UIInterfaceOrientationLandscapeLeft",
                "UIInterfaceOrientationLandscapeRight",
            ]
        )
    }

    private func requireIsolatedTestPlan() -> Bool {
        guard ProcessInfo.processInfo.environment["SURF_ACE_XCTEST_HOST_NO_AUTOSTART"] == "1" else {
            XCTFail("Fixed-port safety tests require the isolated XCTest plan")
            return false
        }
        return true
    }

    private func loadAppInfoPlist() throws -> [String: Any] {
        let plistURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .appendingPathComponent("SurfAce/Info.plist")
        let data = try Data(contentsOf: plistURL)
        let plist = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(plist as? [String: Any])
    }
}
