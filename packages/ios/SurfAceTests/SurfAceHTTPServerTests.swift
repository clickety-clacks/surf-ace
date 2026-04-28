import Darwin
import XCTest
@testable import SurfAce

final class SurfAceHTTPServerTests: XCTestCase {
    func testFixedPortConstantIs19001() {
        XCTAssertEqual(SurfAceHTTPServer.fixedPort, 19_001)
    }

    func testStartForTestingBindsRequestedFixedPort() async throws {
        let server = SurfAceHTTPServer()
        let port = try nextAvailablePort()

        let boundPort = try await server.startForTesting(
            port: port,
            httpHandler: { _ in HTTPServerResponse.empty(statusCode: 200) },
            webSocketHandler: { _ in }
        )

        XCTAssertEqual(boundPort, port)
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

    func testStartFailsWhenFixedPortIsAlreadyInUse() async throws {
        let firstServer = SurfAceHTTPServer()
        let secondServer = SurfAceHTTPServer()
        let port = try nextAvailablePort()

        _ = try await firstServer.startForTesting(
            port: port,
            httpHandler: { _ in HTTPServerResponse.empty(statusCode: 200) },
            webSocketHandler: { _ in }
        )

        do {
            _ = try await secondServer.startForTesting(
                port: port,
                httpHandler: { _ in HTTPServerResponse.empty(statusCode: 200) },
                webSocketHandler: { _ in }
            )
            XCTFail("Expected bind failure when fixed port is already in use")
        } catch {
            XCTAssertFalse(error.localizedDescription.isEmpty)
        }

        await firstServer.stop()
        await secondServer.stop()
    }

    func testStartWithFallbackBindsNextAvailablePortWhenPreferredPortIsInUse() async throws {
        let firstServer = SurfAceHTTPServer()
        let secondServer = SurfAceHTTPServer()
        let port = try nextAvailablePort()

        _ = try await firstServer.startForTesting(
            port: port,
            httpHandler: { _ in HTTPServerResponse.empty(statusCode: 200) },
            webSocketHandler: { _ in }
        )

        let boundPort = try await secondServer.startWithFallbackForTesting(
            preferredPort: port,
            fallbackPortOffsetLimit: 2,
            httpHandler: { _ in HTTPServerResponse.empty(statusCode: 200) },
            webSocketHandler: { _ in }
        )

        XCTAssertEqual(boundPort, port + 1)

        await firstServer.stop()
        await secondServer.stop()
    }

    func testInfoPlistDeclaresLocalNetworkPrivacyUsage() throws {
        let info = try loadAppInfoPlist()
        let usageDescription = try XCTUnwrap(info["NSLocalNetworkUsageDescription"] as? String)
        XCTAssertFalse(usageDescription.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
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

    private func nextAvailablePort() throws -> UInt16 {
        for candidate in UInt16(29_001)...UInt16(29_100) {
            let descriptor = socket(AF_INET, SOCK_STREAM, 0)
            guard descriptor >= 0 else {
                continue
            }
            defer { close(descriptor) }

            var value: Int32 = 1
            setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &value, socklen_t(MemoryLayout<Int32>.size))

            var address = sockaddr_in()
            address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            address.sin_family = sa_family_t(AF_INET)
            address.sin_port = candidate.bigEndian
            address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

            let result = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }

            if result == 0 {
                return candidate
            }
        }

        throw XCTSkip("No free TCP port available in test range")
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
