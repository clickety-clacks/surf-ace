import SwiftUI

@main
struct SurfAceApp: App {
    @State private var runtime = SurfAceRuntime()

    var body: some Scene {
        WindowGroup {
            SurfAceRootView(runtime: runtime)
                .task {
                    await runtime.start()
                }
        }
    }
}
