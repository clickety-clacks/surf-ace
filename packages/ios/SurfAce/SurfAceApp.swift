import SwiftUI

private enum SurfAceSceneID {
    static let mainWindow = "surf-ace-main-window"
}

private struct SurfAceWindowCommands: Commands {
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("New Window") {
                openWindow(id: SurfAceSceneID.mainWindow)
            }
            .keyboardShortcut("n")
        }
    }
}

@main
struct SurfAceApp: App {
    @State private var runtime = SurfAceRuntime()

    var body: some Scene {
        WindowGroup(id: SurfAceSceneID.mainWindow) {
            SurfAceRootView(runtime: runtime)
                .task {
                    await runtime.start()
                }
        }
        .commands {
            SurfAceWindowCommands()
        }
    }
}
