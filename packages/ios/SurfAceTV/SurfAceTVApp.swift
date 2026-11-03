import SwiftUI

@main
struct SurfAceTVApp: App {
    @State private var runtime = SurfAceRuntime()
    var body: some Scene {
        WindowGroup {
            SurfAceTVRoot(runtime: runtime)
                .task {
                    let environment = ProcessInfo.processInfo.environment
                    guard environment["SURF_ACE_XCTEST_HOST_NO_AUTOSTART"] != "1",
                          environment["XCTestConfigurationFilePath"] == nil else { return }
                    await runtime.start()
                    if runtime.surfaces.isEmpty {
                        _ = await runtime.registerSurfaceForScene(sceneKey: "tv-main")
                    }
                }
        }
    }
}
