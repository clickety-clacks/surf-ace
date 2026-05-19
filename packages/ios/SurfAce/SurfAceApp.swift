import SwiftUI
import UIKit

enum SurfAceSceneID {
    static let mainWindow = "surf-ace-main-window"
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
        guard UIApplication.shared.supportsMultipleScenes else {
            log(event: "new_window_unsupported", fields: [("source", source)])
            return
        }

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
                .surfAceSpatialWindowContentSizing()
                .surfAceSpatialWindowTransparency()
                .surfAceSpatialWindowOrnament()
                .task {
                    await runtime.start()
                }
        }
        .surfAceSpatialWindowSizing()
        .commands {
            SurfAceWindowCommands()
        }
    }
}

private extension View {
    @ViewBuilder
    func surfAceSpatialWindowContentSizing() -> some View {
        #if os(visionOS)
        self.frame(minWidth: 480, minHeight: 320)
        #else
        self
        #endif
    }

    @ViewBuilder
    func surfAceSpatialWindowTransparency() -> some View {
        #if os(visionOS)
        self.background(SurfAceSpatialWindowTransparencyProbe())
        #else
        self
        #endif
    }

    @ViewBuilder
    func surfAceSpatialWindowOrnament() -> some View {
        #if os(visionOS)
        self.modifier(SurfAceSpatialWindowOrnament())
        #else
        self
        #endif
    }
}

private extension Scene {
    @SceneBuilder
    func surfAceSpatialWindowSizing() -> some Scene {
        #if os(visionOS)
        self
            .defaultSize(width: 1200, height: 800)
            .windowResizability(.contentMinSize)
            .windowStyle(.plain)
        #else
        self
        #endif
    }
}

#if os(visionOS)
private struct SurfAceSpatialWindowOrnament: ViewModifier {
    @Environment(\.openWindow) private var openWindow

    func body(content: Content) -> some View {
        content
            .ornament(visibility: .visible, attachmentAnchor: .scene(.top)) {
                Button {
                    SurfAceSceneActivation.requestNewWindow(source: "spatial_ornament_plus", openWindow: openWindow)
                } label: {
                    Image(systemName: "plus")
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("New Window")
            }
    }
}

@MainActor
private struct SurfAceSpatialWindowTransparencyProbe: UIViewRepresentable {
    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.backgroundColor = .clear
        clearHostingBackgrounds(near: view)
        scheduleDeferredClear(from: view)
        return view
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        uiView.backgroundColor = .clear
        clearHostingBackgrounds(near: uiView)
        scheduleDeferredClear(from: uiView)
    }

    private func scheduleDeferredClear(from view: UIView) {
        DispatchQueue.main.async {
            clearHostingBackgrounds(near: view)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
            clearHostingBackgrounds(near: view)
        }
    }

    private func clearHostingBackgrounds(near view: UIView) {
        if let window = view.window {
            setHostingBackgroundsClear(in: window)
            return
        }

        var root = view
        while let superview = root.superview {
            root = superview
        }
        setHostingBackgroundsClear(in: root)
    }

    private func setHostingBackgroundsClear(in view: UIView) {
        if String(describing: type(of: view)).contains("UIHostingView") {
            view.backgroundColor = .clear
        }
        for subview in view.subviews {
            setHostingBackgroundsClear(in: subview)
        }
    }
}
#else
private struct SurfAceSpatialWindowTransparencyProbe: View {
    var body: some View {
        EmptyView()
    }
}
#endif
