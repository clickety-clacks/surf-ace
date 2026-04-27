import SwiftUI
import UIKit

private enum SurfAceSceneID {
    static let mainWindow = "surf-ace-main-window"
}

private struct SurfAceWindowCommands: Commands {
    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("New Window") {
                SurfAceSceneActivation.openNewWindow(source: "swiftui_command")
            }
            .keyboardShortcut("n")
        }
    }
}

@MainActor
enum SurfAceSceneActivation {
    static func openNewWindow(source: String) {
        print("[surf-ace:ios:shortcut] event=new_window_requested source=\(source) at=\(ISO8601DateFormatter().string(from: Date()))")
        UIApplication.shared.requestSceneSessionActivation(
            nil,
            userActivity: nil,
            options: nil
        ) { error in
            print("[surf-ace:ios:shortcut] event=new_window_failed source=\(source) error=\"\(error.localizedDescription)\" at=\(ISO8601DateFormatter().string(from: Date()))")
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
