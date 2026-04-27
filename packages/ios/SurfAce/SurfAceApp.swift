import SwiftUI
import UIKit

enum SurfAceSceneID {
    static let mainWindow = "surf-ace-main-window"
}

extension Notification.Name {
    static let surfAceCommandToast = Notification.Name("SurfAceCommandToast")
}

@MainActor
enum SurfAceCommandToast {
    static func show(_ message: String) {
        NotificationCenter.default.post(name: .surfAceCommandToast, object: message)
    }
}

@MainActor
enum SurfAceSceneActivation {
    private static let formatter = ISO8601DateFormatter()

    static func requestNewWindow(source: String, openWindow: OpenWindowAction? = nil) {
        let beforeCount = UIApplication.shared.connectedScenes.count
        log(
            event: "new_window_requested",
            fields: [
                ("source", source),
                ("scene_count_before", String(beforeCount)),
                ("supports_multiple_scenes", UIApplication.shared.supportsMultipleScenes ? "1" : "0")
            ]
        )

        if let openWindow {
            log(event: "open_window_call", fields: [("source", source), ("window_id", SurfAceSceneID.mainWindow)])
            openWindow(id: SurfAceSceneID.mainWindow)
        } else {
            requestUIKitSceneActivation(source: source)
            return
        }

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            let afterCount = UIApplication.shared.connectedScenes.count
            log(
                event: "new_window_post_openwindow_probe",
                fields: [
                    ("source", source),
                    ("scene_count_before", String(beforeCount)),
                    ("scene_count_after", String(afterCount))
                ]
            )
            if afterCount <= beforeCount {
                requestUIKitSceneActivation(source: "\(source):fallback")
            }
        }
    }

    private static func requestUIKitSceneActivation(source: String) {
        log(event: "scene_activation_request", fields: [("source", source)])
        UIApplication.shared.requestSceneSessionActivation(
            nil,
            userActivity: nil,
            options: nil
        ) { error in
            Task { @MainActor in
                log(
                    event: "scene_activation_failed",
                    fields: [
                        ("source", source),
                        ("error", error.localizedDescription)
                    ]
                )
            }
        }
    }

    static func log(event: String, fields: [(String, String)]) {
        let payload = fields
            .map { "\($0.0)=\($0.1.replacingOccurrences(of: " ", with: "_"))" }
            .joined(separator: " ")
        print("[SurfAce-SceneActivation] event=\(event) at=\(formatter.string(from: Date())) \(payload)")
    }
}

private struct SurfAceWindowCommands: Commands {
    @Environment(\.openWindow) private var openWindow

    var body: some Commands {
        CommandGroup(after: .newItem) {
            Button("New Window") {
                SurfAceCommandToast.show("CMD-N received")
                SurfAceSceneActivation.requestNewWindow(source: "swiftui_command", openWindow: openWindow)
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
