import Observation
import PDFKit
import PencilKit
import Security
import SwiftUI
import UIKit
import WebKit

struct SurfAceRootView: View {
    @Bindable var runtime: SurfAceRuntime
    @Environment(\.displayScale) private var displayScale
    @State private var sceneKey: String?
    @State private var surfaceId: String?

    var body: some View {
        ZStack {
            if let surface {
                SurfAceWindowView(runtime: runtime, surface: surface)
                    .onAppear {
                        runtime.updateViewport(surfaceId: surface.surfaceId, size: surface.viewportSize, scale: displayScale)
                    }
            } else {
                Color.black
                    .overlay {
                        ProgressView()
                            .tint(.white)
                    }
            }
        }
        .ignoresSafeArea()
        .background {
            SurfAceSceneProbeRepresentable(
                onConnect: { key, scene in
                    Task { @MainActor in
                        sceneKey = key
                        let surface = runtime.registerSurface(sceneKey: key, scene: scene)
                        surfaceId = surface.surfaceId
                    }
                }
            )
        }
    }

    private var surface: SurfAceSurfaceModel? {
        guard let surfaceId else { return nil }
        return runtime.surfaces.first { $0.surfaceId == surfaceId }
    }
}

private struct SurfAceWindowView: View {
    let runtime: SurfAceRuntime
    @Bindable var surface: SurfAceSurfaceModel
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .top) {
                SurfAcePaneTreeView(runtime: runtime, surface: surface, node: surface.paneLayout)
                    .background(Color.black.opacity(0.94))
                    .onAppear {
                        runtime.updateViewport(surfaceId: surface.surfaceId, size: proxy.size, scale: displayScale)
                    }
                    .onChange(of: proxy.size) { _, newSize in
                        runtime.updateViewport(surfaceId: surface.surfaceId, size: newSize, scale: displayScale)
                    }

                if surface.labelsVisible {
                    SurfAceWindowTitlePill(
                        name: surface.name,
                        providerName: surface.providerName,
                        connectionState: surface.connectionBarState
                    )
                        .padding(.top, 18)
                        .transition(.opacity)
                }
            }
            .overlay(alignment: .bottom) {
                SurfAceConnectionStateBar(state: surface.connectionBarState)
            }
        }
    }
}

private struct SurfAcePaneTreeView: View {
    let runtime: SurfAceRuntime
    @Bindable var surface: SurfAceSurfaceModel
    let node: SurfAcePaneLayoutNode

    var body: some View {
        switch node {
        case .empty:
            Color.black.opacity(0.94)
        case .leaf(let paneId):
            if let pane = surface.panesById[paneId] {
                SurfAcePaneView(runtime: runtime, surface: surface, pane: pane)
            } else {
                Color.clear
            }
        case .split(let direction, let children):
            Group {
                if direction == .vertical {
                    HStack(spacing: 1) {
                        ForEach(children, id: \.layoutIdentity) { child in
                            SurfAcePaneTreeView(runtime: runtime, surface: surface, node: child)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                } else {
                    VStack(spacing: 1) {
                        ForEach(children, id: \.layoutIdentity) { child in
                            SurfAcePaneTreeView(runtime: runtime, surface: surface, node: child)
                                .frame(maxWidth: .infinity, maxHeight: .infinity)
                        }
                    }
                }
            }
            .background(Color.white.opacity(0.12))
        }
    }
}

private struct SurfAcePaneView: View {
    let runtime: SurfAceRuntime
    @Bindable var surface: SurfAceSurfaceModel
    @Bindable var pane: SurfAcePaneModel

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                SurfAcePaneRepresentable(
                    runtime: runtime,
                    surfaceId: surface.surfaceId,
                    paneId: pane.paneId
                )
                .background(Color.black.opacity(0.92))

                if surface.labelsVisible {
                    SurfAcePaneNumberIndicator(label: pane.labelText, paneHeight: proxy.size.height)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomTrailing)
                        .padding(.trailing, 28)
                        .padding(.bottom, 28)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                        .transition(.opacity)
                }

                if let toast = pane.toast {
                    VStack {
                        Spacer()
                        Text(toast)
                            .font(.system(size: 13, weight: .semibold, design: .rounded))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(.black.opacity(0.74), in: Capsule())
                            .padding(.bottom, 96)
                    }
                    .onAppear {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            runtime.clearToast(surfaceId: surface.surfaceId, paneId: pane.paneId)
                        }
                    }
                }

                VStack {
                    Spacer()
                    SurfAcePaneControls(runtime: runtime, surface: surface, pane: pane)
                        .padding(.bottom, 28)
                }
            }
            .overlay {
                SurfAceAnnotationBorder(
                    active: pane.annotationMode && surface.activeKeyboardPaneId != pane.paneId,
                    pulsing: pane.isDrawingFlushSending
                )
            }
            .overlay {
                SurfAceKeyboardActiveBorder(active: surface.activeKeyboardPaneId == pane.paneId)
                    .allowsHitTesting(false)
                    .zIndex(10_000)
            }
            .onChange(of: proxy.size) { _, newSize in
                pane.lastMeasuredSize = newSize
            }
        }
        .contentShape(Rectangle())
        .simultaneousGesture(
            TapGesture().onEnded {
                runtime.activateKeyboardPane(surfaceId: surface.surfaceId, paneId: pane.paneId)
            }
        )
        .clipped()
    }
}

private struct SurfAcePaneNumberIndicator: View {
    let label: String
    let paneHeight: CGFloat

    private var fontSize: CGFloat {
        max(64, paneHeight / 6)
    }

    var body: some View {
        Text(label)
            .font(.system(size: fontSize, weight: .black, design: .rounded))
            .monospacedDigit()
            .foregroundStyle(.white.opacity(0.20))
            .lineLimit(1)
            .minimumScaleFactor(0.35)
            .padding(.horizontal, fontSize * 0.12)
            .frame(minWidth: fontSize * 0.78, minHeight: fontSize * 0.78)
            .background(.black.opacity(0.05), in: Capsule())
            .overlay {
                Capsule()
                    .strokeBorder(.white.opacity(0.05), lineWidth: 1)
            }
    }
}

private struct SurfAcePaneControls: View {
    let runtime: SurfAceRuntime
    @Bindable var surface: SurfAceSurfaceModel
    @Bindable var pane: SurfAcePaneModel

    var body: some View {
        HStack(spacing: 12) {
            if pane.drawingRestoreWarningVisible {
                SurfAceWarningIndicator()
            }

            if pane.annotationMode {
                Button {
                    runtime.setAnnotationMode(
                        surfaceId: surface.surfaceId,
                        paneId: pane.paneId,
                        enabled: true,
                        fingerDrawEnabled: !pane.fingerDrawEnabled
                    )
                } label: {
                    Image(systemName: "hand.draw")
                }
                .buttonStyle(SurfAceGlassButtonStyle())

                Button("Done") {
                    runtime.setAnnotationMode(
                        surfaceId: surface.surfaceId,
                        paneId: pane.paneId,
                        enabled: false,
                        fingerDrawEnabled: false
                    )
                }
                .buttonStyle(SurfAceGlassButtonStyle())
            } else {
                if pane.canGoBack {
                    Button {
                        runtime.navigateHistory(
                            surfaceId: surface.surfaceId,
                            paneId: pane.paneId,
                            direction: .back
                        )
                    } label: {
                        Image(systemName: "chevron.backward")
                    }
                    .buttonStyle(SurfAceGlassButtonStyle())
                }

                if pane.canGoForward {
                    Button {
                        runtime.navigateHistory(
                            surfaceId: surface.surfaceId,
                            paneId: pane.paneId,
                            direction: .forward
                        )
                    } label: {
                        Image(systemName: "chevron.forward")
                    }
                    .buttonStyle(SurfAceGlassButtonStyle())
                }

                Button {
                    runtime.setAnnotationMode(
                        surfaceId: surface.surfaceId,
                        paneId: pane.paneId,
                        enabled: true,
                        fingerDrawEnabled: true
                    )
                } label: {
                    Image(systemName: "hand.draw")
                }
                .buttonStyle(SurfAceGlassButtonStyle())
            }
        }
    }
}

private struct SurfAceWarningIndicator: View {
    var body: some View {
        Image(systemName: "exclamationmark.triangle.fill")
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(Color.yellow)
            .frame(minWidth: 44, minHeight: 44)
            .padding(.horizontal, 10)
            .background(.black.opacity(0.58), in: Capsule())
            .accessibilityLabel("Drawing restore warning")
    }
}

private struct SurfAceGlassButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 18, weight: .semibold))
            .foregroundStyle(.white)
            .frame(minWidth: 44, minHeight: 44)
            .padding(.horizontal, 10)
            .background(.black.opacity(configuration.isPressed ? 0.78 : 0.58), in: Capsule())
            .scaleEffect(configuration.isPressed ? 0.96 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

private struct SurfAceAnnotationBorder: View {
    let active: Bool
    let pulsing: Bool
    @State private var animatePulse = false

    var body: some View {
        RoundedRectangle(cornerRadius: 0, style: .continuous)
            .strokeBorder(Color.orange.opacity(active ? (pulsing && animatePulse ? 0.42 : 0.95) : 0), lineWidth: 2)
            .animation(.easeInOut(duration: 0.2), value: active)
            .onAppear {
                animatePulse = pulsing
            }
            .onChange(of: pulsing) { _, newValue in
                if newValue {
                    withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                        animatePulse = true
                    }
                } else {
                    animatePulse = false
                }
            }
    }
}

private struct SurfAceKeyboardActiveBorder: View {
    let active: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: 0, style: .continuous)
            .strokeBorder(Color.white.opacity(active ? 0.20 : 0), lineWidth: 10)
            .allowsHitTesting(false)
            .animation(.easeOut(duration: 0.12), value: active)
    }
}

private struct SurfAceConnectionStateBar: View {
    let state: SurfAceConnectionBarState
    @State private var highlightOffset: CGFloat = -1

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(baseColor.opacity(0.8))

                if state == .connecting {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(Color.white.opacity(0.5))
                        .frame(width: max(44, proxy.size.width * 0.18))
                        .offset(x: highlightOffset * max(proxy.size.width - max(44, proxy.size.width * 0.18), 1))
                        .animation(.linear(duration: 1.2).repeatForever(autoreverses: true), value: highlightOffset)
                        .onAppear {
                            highlightOffset = 1
                        }
                }
            }
        }
        .frame(height: 2)
        .ignoresSafeArea(edges: .bottom)
    }

    private var baseColor: Color {
        switch state {
        case .connected:
            return Color(red: 0.13, green: 0.77, blue: 0.37)
        case .connecting:
            return Color(red: 0.96, green: 0.65, blue: 0.04)
        case .disconnected:
            return Color(red: 0.94, green: 0.27, blue: 0.27)
        }
    }
}

private struct SurfAceWindowTitlePill: View {
    let name: String
    let providerName: String?
    let connectionState: SurfAceConnectionBarState

    var body: some View {
        VStack(spacing: 2) {
            Text(name)
                .font(.system(.title2, design: .rounded).weight(.semibold))
                .foregroundStyle(.white.opacity(0.94))
                .lineLimit(1)
                .truncationMode(.tail)

            Text(subtitleText)
                .font(.system(.caption, design: .rounded).weight(.medium))
                .foregroundStyle(.white.opacity(0.68))
                .lineLimit(1)
                .truncationMode(.tail)
        }
        .frame(maxWidth: 520)
        .padding(.horizontal, 20)
        .padding(.vertical, 12)
        .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(.white.opacity(0.12), lineWidth: 0.8)
        }
        .padding(.horizontal, 20)
        .allowsHitTesting(false)
    }

    private var subtitleText: String {
        switch connectionState {
        case .connected:
            if let providerName,
               !providerName.isEmpty {
                return providerName
            }
            return "unknown agent"
        case .connecting:
            return "connecting…"
        case .disconnected:
            return "not connected"
        }
    }
}

private struct SurfAcePaneRepresentable: UIViewRepresentable {
    let runtime: SurfAceRuntime
    let surfaceId: String
    let paneId: Int

    func makeCoordinator() -> Coordinator {
        Coordinator(runtime: runtime, surfaceId: surfaceId, paneId: paneId)
    }

    func makeUIView(context: Context) -> SurfAceSurfaceHostView {
        let view = SurfAceSurfaceHostView()
        context.coordinator.attach(hostView: view)
        runtime.attachPaneBridge(surfaceId: surfaceId, paneId: paneId, bridge: context.coordinator)
        return view
    }

    func updateUIView(_ uiView: SurfAceSurfaceHostView, context: Context) {}

    static func dismantleUIView(_ uiView: SurfAceSurfaceHostView, coordinator: Coordinator) {
        coordinator.detach()
    }

    @MainActor
    final class Coordinator: NSObject, SurfAcePaneBridging {
        private weak var hostView: SurfAceSurfaceHostView?
        private let runtime: SurfAceRuntime
        private let surfaceId: String
        private let paneId: Int

        init(runtime: SurfAceRuntime, surfaceId: String, paneId: Int) {
            self.runtime = runtime
            self.surfaceId = surfaceId
            self.paneId = paneId
        }

        func attach(hostView: SurfAceSurfaceHostView) {
            self.hostView = hostView
            hostView.onInteractionBegan = { [weak self] in
                guard let self else { return }
                self.runtime.activateKeyboardPane(surfaceId: self.surfaceId, paneId: self.paneId)
            }
            hostView.onSelectionChanged = { [weak self] text, rect in
                guard let self else { return }
                self.runtime.handleSelectionChanged(surfaceId: self.surfaceId, paneId: self.paneId, text: text, rect: rect)
            }
            hostView.onScrollSettled = { [weak self] viewport, visibleText in
                guard let self else { return }
                self.runtime.handleScrollSettled(surfaceId: self.surfaceId, paneId: self.paneId, viewport: viewport, visibleText: visibleText)
            }
            hostView.onTapEvent = { [weak self] kind, position, nearestContent in
                guard let self else { return }
                self.runtime.handleTapEvent(surfaceId: self.surfaceId, paneId: self.paneId, kind: kind, position: position, nearestContent: nearestContent)
            }
            hostView.onNavigationEvent = { [weak self] url, sentAt in
                guard let self else { return }
                self.runtime.handleNavigationEvent(surfaceId: self.surfaceId, paneId: self.paneId, url: url, sentAt: sentAt)
            }
            hostView.onPDFPageChanged = { [weak self] page, totalPages, pageText in
                guard let self else { return }
                self.runtime.handlePDFPageChanged(
                    surfaceId: self.surfaceId,
                    paneId: self.paneId,
                    page: page,
                    totalPages: totalPages,
                    pageText: pageText
                )
            }
            hostView.onStrokeBatch = { [weak self] strokes, drawingData in
                guard let self else { return }
                self.runtime.handleNewStrokes(
                    surfaceId: self.surfaceId,
                    paneId: self.paneId,
                    strokes: strokes,
                    drawingData: drawingData
                )
            }
        }

        func detach() {
            runtime.detachPaneBridge(surfaceId: surfaceId, paneId: paneId)
            hostView = nil
        }

        func render(entry: SurfAcePaneEntry?, restoreViewport: SurfAceViewport?) {
            hostView?.render(entry: entry, restoreViewport: restoreViewport)
        }

        func renderBrowserURL(entry: SurfAcePaneEntry) async -> SurfAceBrowserNavigationResult {
            guard let hostView else {
                return SurfAceBrowserNavigationResult(errorMessage: "pane bridge is detached", status: "failed", url: entry.url ?? "")
            }
            return await hostView.renderBrowserURL(entry: entry)
        }

        func setInteraction(annotationMode: Bool, fingerDrawEnabled: Bool) {
            hostView?.setInteraction(annotationMode: annotationMode, fingerDrawEnabled: fingerDrawEnabled)
        }

        func restoreDrawing(from drawingData: Data, strokes: [SurfAceStroke]) -> Bool {
            hostView?.restoreDrawing(from: drawingData, strokes: strokes) ?? drawingData.isEmpty
        }

        func captureDrawingData() -> Data {
            hostView?.captureDrawingData() ?? Data()
        }

        func fetchSnapshot(includeImage: Bool) async -> SurfAceSurfaceSnapshot? {
            await hostView?.fetchSnapshot(includeImage: includeImage)
        }

        func applyHTMLPatch(_ patch: SurfAceFramePatchRequest) async -> SurfAceHTMLPatchResult {
            await hostView?.applyHTMLPatch(patch) ?? .failed("pane renderer unavailable")
        }

        func removeDrawingStrokeIDs(_ strokeIDs: [String]) {
            hostView?.removeDrawingStrokeIDs(strokeIDs)
        }

        func clearDrawings() {
            hostView?.clearDrawings()
        }
    }
}

@MainActor
final class SurfAceSceneProbeController: UIViewController {
    var onConnect: (@Sendable (String, UIScene) -> Void)?
    private var connectedSceneKey: String?

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        resolveSceneKeyIfNeeded()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        resolveSceneKeyIfNeeded()
    }

    private func resolveSceneKeyIfNeeded() {
        guard connectedSceneKey == nil,
              let scene = view.window?.windowScene else {
            return
        }
        let sceneKey = scene.session.persistentIdentifier
        connectedSceneKey = sceneKey
        SurfAceSceneActivation.log(
            event: "scene_probe_connect",
            fields: [
                ("scene_key", sceneKey),
                ("activation_state", "\(scene.activationState.rawValue)")
            ]
        )
        onConnect?(sceneKey, scene)
    }
}

private struct SurfAceSceneProbeRepresentable: UIViewControllerRepresentable {
    let onConnect: @Sendable (String, UIScene) -> Void

    func makeUIViewController(context: Context) -> SurfAceSceneProbeController {
        let controller = SurfAceSceneProbeController()
        controller.view.isHidden = true
        controller.onConnect = onConnect
        return controller
    }

    func updateUIViewController(_ uiViewController: SurfAceSceneProbeController, context: Context) {
        uiViewController.onConnect = onConnect
    }
}

@MainActor
private final class SurfAceWeakScriptMessageHandler: NSObject, WKScriptMessageHandler {
    weak var target: WKScriptMessageHandler?

    init(target: WKScriptMessageHandler) {
        self.target = target
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(userContentController, didReceive: message)
    }
}

@MainActor
final class SurfAceSurfaceHostView: UIView, PKCanvasViewDelegate, WKScriptMessageHandler, WKNavigationDelegate {
    var onInteractionBegan: (() -> Void)?
    var onSelectionChanged: ((String, CGRect?) -> Void)?
    var onScrollSettled: ((SurfAceViewport, String) -> Void)?
    var onTapEvent: ((String, SurfAcePoint, String) -> Void)?
    var onNavigationEvent: ((String, Int64) -> Void)?
    var onPDFPageChanged: ((Int, Int, String?) -> Void)?
    var onStrokeBatch: (([SurfAceStroke], Data) -> Void)?

    private struct TrackedStroke {
        let strokeId: String
        var stroke: PKStroke
        var signature: String
    }

    private let selectionMessageName = "surfAceSelection"
    private let scrollMessageName = "surfAceScroll"
    private let tapMessageName = "surfAceTap"
    private let navigationMessageName = "surfAceNavigation"
    private let focusMessageName = "surfAceFocus"

    private let webView: WKWebView
    private let pdfView = PDFView()
    private let canvasView = PKCanvasView()
    private var currentEntry: SurfAcePaneEntry?
    private var pendingBrowserNavigation: CheckedContinuation<SurfAceBrowserNavigationResult, Never>?
    private var pendingBrowserNavigationLoad: WKNavigation?
    private var pendingBrowserNavigationURL: String?
    private var annotationMode = false
    private var fingerDrawEnabled = false
    private var trackedStrokes: [TrackedStroke] = []
    private var isApplyingProgrammaticDrawingChange = false
    private var pendingViewportRestore: SurfAceViewport?
    private var pendingHTMLRenderTask: Task<Void, Never>?
    private var pendingHTMLRenderContinuation: CheckedContinuation<Void, Never>?
    private var lastViewport = SurfAceViewport(
        scrollOffset: SurfAcePoint(x: 0, y: 0),
        visibleRect: SurfAceRect(x: 0, y: 0, width: 1, height: 1),
        contentSize: SurfAceSize(width: 1, height: 1),
        zoomLevel: 1
    )
    private var lastVisibleText = ""
    private var lastSelection: SurfAceSelection?

    override init(frame: CGRect) {
        let config = WKWebViewConfiguration()
        let contentController = WKUserContentController()
        config.userContentController = contentController
        config.allowsInlineMediaPlayback = true
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init(frame: frame)
        webView.navigationDelegate = self
        setupViewHierarchy()
        setupScripts()
        setupPDFTracking()
        setupInteractionTracking()
        render(entry: nil, restoreViewport: nil)
    }

    required init?(coder: NSCoder) {
        nil
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    func render(entry: SurfAcePaneEntry?, restoreViewport: SurfAceViewport?) {
        finishPendingBrowserNavigation(
            status: "failed",
            errorMessage: "browser_url navigation was superseded",
            url: pendingBrowserNavigationURL
        )
        currentEntry = entry
        pendingViewportRestore = nil
        let html: String
        let baseURL: URL?

        if let entry {
            switch entry.payload {
            case .html(let rawHTML, let suppliedBaseURL):
                html = rawHTML
                baseURL = suppliedBaseURL.flatMap(URL.init(string:))
                pendingViewportRestore = restoreViewport
                beginPendingHTMLRender()
                showWebView()
            case .image(let data, let mediaType, let alt):
                finishPendingHTMLRender()
                html = imageHTML(data: data, mediaType: mediaType, alt: alt)
                baseURL = nil
                showWebView()
            case .pdf(let data):
                finishPendingHTMLRender()
                renderPDF(data)
                applyCurrentInteractionState()
                return
            case .terminal(let lines, _):
                finishPendingHTMLRender()
                html = terminalHTML(lines: lines)
                baseURL = nil
                showWebView()
            case .markdown(let markdown):
                finishPendingHTMLRender()
                html = markdownHTML(markdown)
                baseURL = nil
                showWebView()
            case .video(let url):
                finishPendingHTMLRender()
                html = videoHTML(url: url)
                baseURL = nil
                showWebView()
            case .some(.canvas):
                finishPendingHTMLRender()
                html = placeholderHTML(title: "Canvas", detail: "No preview is available for this pane.")
                baseURL = nil
                showWebView()
            case .browserURL(let url, _, _):
                finishPendingHTMLRender()
                guard let requestURL = URL(string: url) else {
                    html = placeholderHTML(title: "Browser URL", detail: "Invalid URL.")
                    baseURL = nil
                    showWebView()
                    break
                }
                showWebView()
                webView.load(URLRequest(url: requestURL))
                applyCurrentInteractionState()
                return
            case nil:
                finishPendingHTMLRender()
                html = standbyHTML()
                baseURL = nil
                showWebView()
            }
        } else {
            finishPendingHTMLRender()
            html = standbyHTML()
            baseURL = nil
            showWebView()
        }

        webView.loadHTMLString(html, baseURL: baseURL)
        applyCurrentInteractionState()
    }

    func renderBrowserURL(entry: SurfAcePaneEntry) async -> SurfAceBrowserNavigationResult {
        finishPendingBrowserNavigation(
            status: "failed",
            errorMessage: "browser_url navigation was superseded",
            url: pendingBrowserNavigationURL
        )
        return await withCheckedContinuation { continuation in
            currentEntry = entry
            pendingViewportRestore = nil
            pendingBrowserNavigation = continuation
            pendingBrowserNavigationURL = entry.url
            guard case .browserURL(let url, _, _) = entry.payload,
                  let requestURL = URL(string: url) else {
                finishPendingBrowserNavigation(status: "failed", errorMessage: "Invalid URL.", url: entry.url)
                return
            }
            finishPendingHTMLRender()
            showWebView()
            let navigation = webView.load(URLRequest(url: requestURL))
            pendingBrowserNavigationLoad = navigation
            applyCurrentInteractionState()
            Task { @MainActor [weak self] in
                try? await Task.sleep(nanoseconds: 8_000_000_000)
                self?.finishPendingBrowserNavigation(
                    status: "failed",
                    errorMessage: "browser_url navigation was not verified before timeout",
                    navigation: navigation,
                    url: self?.pendingBrowserNavigationURL
                )
            }
        }
    }

    func setInteraction(annotationMode: Bool, fingerDrawEnabled: Bool) {
        self.annotationMode = annotationMode
        self.fingerDrawEnabled = fingerDrawEnabled
        applyCurrentInteractionState()
    }

    func restoreDrawing(from drawingData: Data, strokes: [SurfAceStroke]) -> Bool {
        isApplyingProgrammaticDrawingChange = true
        defer { isApplyingProgrammaticDrawingChange = false }

        guard !drawingData.isEmpty else {
            canvasView.drawing = PKDrawing()
            trackedStrokes = []
            return true
        }
        guard let drawing = try? PKDrawing(data: drawingData) else {
            canvasView.drawing = PKDrawing()
            trackedStrokes = []
            return false
        }

        canvasView.drawing = drawing
        trackedStrokes = zip(drawing.strokes, strokes).map { stroke, serialized in
            TrackedStroke(strokeId: serialized.strokeId, stroke: stroke, signature: strokeSignature(stroke))
        }
        return true
    }

    func captureDrawingData() -> Data {
        canvasView.drawing.dataRepresentation()
    }

    func fetchSnapshot(includeImage: Bool) async -> SurfAceSurfaceSnapshot? {
        switch currentEntry?.payload {
        case .html:
            await waitForPendingHTMLRenderIfNeeded()
            if let payload = await evaluateSnapshotPayload() {
                lastViewport = payload.viewport
                lastVisibleText = payload.visibleText
                lastSelection = payload.selection ?? lastSelection
            }
        case .markdown(let markdown):
            lastVisibleText = markdown
        case .image(_, _, let alt):
            lastVisibleText = alt ?? ""
        case .pdf(let data):
            lastViewport = pdfViewport()
            lastVisibleText = currentPDFPageText() ?? extractPDFText(data)
            lastSelection = nil
        case .terminal(let lines, _):
            lastVisibleText = lines.suffix(200).map(SurfAceANSI.strip).joined(separator: "\n")
        case .browserURL(let url, _, _):
            lastVisibleText = url
            lastSelection = nil
        case .some(.video), .some(.canvas):
            lastVisibleText = ""
            lastSelection = nil
        case nil:
            break
        }

        let imageBase64 = includeImage ? captureFullScreenshotBase64() : nil

        return SurfAceSurfaceSnapshot(
            viewport: lastViewport,
            visibleText: lastVisibleText.prefix(4096).description,
            selection: lastSelection,
            imageBase64: imageBase64
        )
    }

    func applyHTMLPatch(_ patch: SurfAceFramePatchRequest) async -> SurfAceHTMLPatchResult {
        let supportedActions: Set<String> = ["replace_inner", "replace_outer", "insert_before", "insert_after", "remove"]
        guard supportedActions.contains(patch.action) else {
            return .invalidAction
        }
        if patch.action != "remove", patch.html == nil {
            return .failed("Patch html is required for action \(patch.action)")
        }

        let payload: [String: Any?] = [
            "selector": patch.selector,
            "action": patch.action,
            "html": patch.html,
        ]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: payload.compactMapValues { $0 }),
              let bodyJSON = String(data: bodyData, encoding: .utf8) else {
            return .failed("Patch payload serialization failed")
        }

        let script = """
        (function() {
          const patch = \(bodyJSON);
          const target = document.querySelector(patch.selector);
          if (!target) { return JSON.stringify({ ok: false, reason: "selector_not_found" }); }
          const html = patch.html || "";
          switch (patch.action) {
            case "replace_inner": target.innerHTML = html; break;
            case "replace_outer": target.outerHTML = html; break;
            case "insert_before": target.insertAdjacentHTML("beforebegin", html); break;
            case "insert_after": target.insertAdjacentHTML("afterend", html); break;
            case "remove": target.remove(); break;
            default: return JSON.stringify({ ok: false, reason: "invalid_action" });
          }
          return JSON.stringify({ ok: true, html: document.documentElement.outerHTML });
        })();
        """

        guard let result = await evaluateJSONObject(script),
              let ok = result["ok"] as? Bool else {
            return .failed("Patch evaluation failed")
        }

        guard ok else {
            switch result["reason"] as? String {
            case "selector_not_found":
                return .selectorNotFound
            case "invalid_action":
                return .invalidAction
            default:
                return .failed("Patch rejected by renderer")
            }
        }

        guard let updatedHTML = result["html"] as? String else {
            return .failed("Updated html unavailable")
        }
        return .success(updatedHTML: updatedHTML)
    }

    func removeDrawingStrokeIDs(_ strokeIDs: [String]) {
        let removeSet = Set(strokeIDs)
        let remaining = trackedStrokes.filter { !removeSet.contains($0.strokeId) }
        trackedStrokes = remaining
        applyDrawing(strokes: remaining.map(\.stroke))
    }

    func clearDrawings() {
        trackedStrokes.removeAll()
        applyDrawing(strokes: [])
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else { return }
        onInteractionBegan?()

        switch message.name {
        case selectionMessageName:
            if let text = body["text"] as? String,
               let rect = parseRect(body["boundingRect"] as? [String: Any]) {
                let selection = SurfAceSelection.text(text, boundingRect: rect.surfAceRect)
                lastSelection = selection
                onSelectionChanged?(text, rect)
            }
        case scrollMessageName:
            guard let viewport = parseViewport(body["viewport"] as? [String: Any]) else { return }
            let visibleText = (body["visibleText"] as? String) ?? ""
            lastViewport = viewport
            lastVisibleText = visibleText
            onScrollSettled?(viewport, visibleText)
        case tapMessageName:
            guard let position = parsePoint(body["position"] as? [String: Any]) else { return }
            let nearestContent = (body["nearestContent"] as? String) ?? ""
            let kind = (body["kind"] as? String) == "long_press" ? "long_press" : "tap"
            onTapEvent?(kind, SurfAcePoint(x: Double(position.x), y: Double(position.y)), nearestContent)
        case navigationMessageName:
            guard let url = body["url"] as? String, !url.isEmpty else { return }
            let sentAt = parseInt64(body["sentAt"]) ?? Int64(Date().timeIntervalSince1970 * 1000)
            onNavigationEvent?(url, sentAt)
        case focusMessageName:
            break
        default:
            break
        }
    }

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        let changed = syncTrackedStrokes(with: canvasView.drawing.strokes, emitChanges: !isApplyingProgrammaticDrawingChange)
        if !isApplyingProgrammaticDrawingChange, !changed.isEmpty {
            onInteractionBegan?()
            onStrokeBatch?(changed, canvasView.drawing.dataRepresentation())
        }
    }

    private func setupViewHierarchy() {
        backgroundColor = .black

        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.keyboardDismissMode = .onDrag

        pdfView.translatesAutoresizingMaskIntoConstraints = false
        pdfView.backgroundColor = .black
        pdfView.autoScales = true
        pdfView.displayMode = .singlePageContinuous
        pdfView.displayDirection = .vertical
        pdfView.usePageViewController(false)

        canvasView.translatesAutoresizingMaskIntoConstraints = false
        canvasView.backgroundColor = .clear
        canvasView.isOpaque = false
        canvasView.delegate = self
        canvasView.tool = PKInkingTool(.pen, color: .systemOrange, width: 4)

        addSubview(webView)
        addSubview(pdfView)
        addSubview(canvasView)

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
            pdfView.leadingAnchor.constraint(equalTo: leadingAnchor),
            pdfView.trailingAnchor.constraint(equalTo: trailingAnchor),
            pdfView.topAnchor.constraint(equalTo: topAnchor),
            pdfView.bottomAnchor.constraint(equalTo: bottomAnchor),
            canvasView.leadingAnchor.constraint(equalTo: leadingAnchor),
            canvasView.trailingAnchor.constraint(equalTo: trailingAnchor),
            canvasView.topAnchor.constraint(equalTo: topAnchor),
            canvasView.bottomAnchor.constraint(equalTo: bottomAnchor),
        ])
    }

    private func setupScripts() {
        let script = WKUserScript(source: bridgeScript(), injectionTime: .atDocumentEnd, forMainFrameOnly: true)
        let controller = webView.configuration.userContentController
        controller.addUserScript(script)
        controller.add(SurfAceWeakScriptMessageHandler(target: self), name: selectionMessageName)
        controller.add(SurfAceWeakScriptMessageHandler(target: self), name: scrollMessageName)
        controller.add(SurfAceWeakScriptMessageHandler(target: self), name: tapMessageName)
        controller.add(SurfAceWeakScriptMessageHandler(target: self), name: navigationMessageName)
        controller.add(SurfAceWeakScriptMessageHandler(target: self), name: focusMessageName)
    }

    private func setupInteractionTracking() {
        let recognizer = UITapGestureRecognizer(target: self, action: #selector(handlePaneTapGesture(_:)))
        recognizer.cancelsTouchesInView = false
        recognizer.delaysTouchesBegan = false
        recognizer.delaysTouchesEnded = false
        addGestureRecognizer(recognizer)
    }

    @objc
    private func handlePaneTapGesture(_ recognizer: UITapGestureRecognizer) {
        if recognizer.state == .ended {
            onInteractionBegan?()
        }
    }

    private func setupPDFTracking() {
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(handlePDFPageChangedNotification(_:)),
            name: Notification.Name.PDFViewPageChanged,
            object: pdfView
        )
    }

    private func applyCurrentInteractionState() {
        let entryScrollable = currentEntry?.scrollable ?? true
        let entryInteractive = currentEntry?.interactive ?? true
        canvasView.isUserInteractionEnabled = annotationMode
        if annotationMode {
            webView.scrollView.isScrollEnabled = false
            webView.isUserInteractionEnabled = false
            pdfView.isUserInteractionEnabled = false
            pdfScrollView()?.isScrollEnabled = false
            canvasView.drawingPolicy = fingerDrawEnabled ? .anyInput : .pencilOnly
        } else {
            webView.scrollView.isScrollEnabled = entryScrollable
            webView.isUserInteractionEnabled = entryInteractive
            pdfView.isUserInteractionEnabled = entryInteractive
            pdfScrollView()?.isScrollEnabled = entryScrollable
            canvasView.drawingPolicy = .pencilOnly
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        Task { @MainActor [weak self] in
            guard let self else { return }
            await self.restorePendingViewportIfNeeded()
            await self.publishCurrentWebViewportIfNeeded()
            self.finishPendingHTMLRender()
            self.finishPendingBrowserNavigation(status: "applied", errorMessage: nil, navigation: navigation, url: self.pendingBrowserNavigationURL)
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finishPendingHTMLRender()
        finishPendingBrowserNavigation(status: "failed", errorMessage: error.localizedDescription, navigation: navigation, url: pendingBrowserNavigationURL)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finishPendingHTMLRender()
        finishPendingBrowserNavigation(status: "failed", errorMessage: error.localizedDescription, navigation: navigation, url: pendingBrowserNavigationURL)
    }

    private func finishPendingBrowserNavigation(status: String, errorMessage: String?, navigation: WKNavigation? = nil, url: String?) {
        guard let continuation = pendingBrowserNavigation else { return }
        if let navigation, pendingBrowserNavigationLoad !== navigation {
            return
        }
        pendingBrowserNavigation = nil
        pendingBrowserNavigationLoad = nil
        let resolvedURL = url ?? pendingBrowserNavigationURL ?? ""
        pendingBrowserNavigationURL = nil
        continuation.resume(returning: SurfAceBrowserNavigationResult(errorMessage: errorMessage, status: status, url: resolvedURL))
    }

    private func showWebView() {
        pdfView.document = nil
        pdfView.isHidden = true
        webView.isHidden = false
    }

    private func renderPDF(_ base64Data: String) {
        webView.isHidden = true
        pdfView.isHidden = false
        guard let data = Data(base64Encoded: base64Data, options: [.ignoreUnknownCharacters]),
              let document = PDFDocument(data: data) else {
            pdfView.document = nil
            webView.loadHTMLString(placeholderHTML(title: "PDF unavailable", detail: "This PDF could not be rendered on iOS."), baseURL: nil)
            showWebView()
            return
        }

        pdfView.document = document
        pdfView.goToFirstPage(nil)
        lastViewport = pdfViewport()
        lastVisibleText = currentPDFPageText() ?? ""
        DispatchQueue.main.async { [weak self] in
            self?.notifyPDFPageChanged()
        }
    }

    private func pdfScrollView() -> UIScrollView? {
        if let scrollView = pdfView.subviews.compactMap({ $0 as? UIScrollView }).first {
            return scrollView
        }
        return pdfView.subviews
            .flatMap(\.subviews)
            .compactMap { $0 as? UIScrollView }
            .first
    }

    private func pdfViewport() -> SurfAceViewport {
        let scrollView = pdfScrollView()
        let contentOffset = scrollView?.contentOffset ?? .zero
        let contentSize = scrollView?.contentSize ?? bounds.size
        return SurfAceViewport(
            scrollOffset: SurfAcePoint(x: Double(contentOffset.x), y: Double(contentOffset.y)),
            visibleRect: SurfAceRect(
                x: Double(contentOffset.x),
                y: Double(contentOffset.y),
                width: Double(max(bounds.width, 1)),
                height: Double(max(bounds.height, 1))
            ),
            contentSize: SurfAceSize(
                width: Double(max(contentSize.width, 1)),
                height: Double(max(contentSize.height, 1))
            ),
            zoomLevel: Double(scrollView?.zoomScale ?? pdfView.scaleFactor)
        )
    }

    private func currentPDFPageText() -> String? {
        pdfView.currentPage?.string?.prefix(4096).description
    }

    @objc
    private func handlePDFPageChangedNotification(_ notification: Notification) {
        notifyPDFPageChanged()
    }

    private func notifyPDFPageChanged() {
        guard let document = pdfView.document,
              let currentPage = pdfView.currentPage else {
            return
        }
        lastViewport = pdfViewport()
        let page = max(document.index(for: currentPage) + 1, 1)
        let totalPages = max(document.pageCount, 1)
        let pageText = currentPage.string?.prefix(4096).description
        lastVisibleText = pageText ?? ""
        onPDFPageChanged?(page, totalPages, pageText)
    }

    private func applyDrawing(strokes: [PKStroke]) {
        isApplyingProgrammaticDrawingChange = true
        canvasView.drawing = PKDrawing(strokes: strokes)
        isApplyingProgrammaticDrawingChange = false
    }

    private func syncTrackedStrokes(with strokes: [PKStroke], emitChanges: Bool) -> [SurfAceStroke] {
        var next: [TrackedStroke] = []
        var changed: [SurfAceStroke] = []

        for (index, stroke) in strokes.enumerated() {
            let signature = strokeSignature(stroke)
            if index < trackedStrokes.count {
                var existing = trackedStrokes[index]
                if existing.signature != signature {
                    existing.signature = signature
                    existing.stroke = stroke
                    if emitChanges {
                        changed.append(serializeStroke(stroke, strokeId: existing.strokeId))
                    }
                } else {
                    existing.stroke = stroke
                }
                next.append(existing)
            } else {
                let strokeId = randomStrokeID()
                let tracked = TrackedStroke(strokeId: strokeId, stroke: stroke, signature: signature)
                next.append(tracked)
                if emitChanges {
                    changed.append(serializeStroke(stroke, strokeId: strokeId))
                }
            }
        }

        trackedStrokes = next
        return changed
    }

    private func strokeSignature(_ stroke: PKStroke) -> String {
        let count = stroke.path.count
        let lastPoint = count > 0 ? stroke.path[count - 1] : nil
        let x = lastPoint?.location.x ?? 0
        let y = lastPoint?.location.y ?? 0
        let force = lastPoint?.force ?? 0
        return "\(count)-\(x)-\(y)-\(force)-\(stroke.ink.inkType.rawValue)"
    }

    private func serializeStroke(_ stroke: PKStroke, strokeId: String) -> SurfAceStroke {
        let nowMilliseconds = Int64(Date().timeIntervalSince1970 * 1000)
        var points: [SurfAceStrokePoint] = []
        for index in 0..<stroke.path.count {
            let point = stroke.path[index]
            points.append(
                SurfAceStrokePoint(
                    x: Double(point.location.x),
                    y: Double(point.location.y),
                    pressure: Double(point.force),
                    timestamp: nowMilliseconds + Int64(point.timeOffset * 1000)
                )
            )
        }
        return SurfAceStroke(
            strokeId: strokeId,
            points: points,
            tool: fingerDrawEnabled ? "finger" : "pencil"
        )
    }

    private func evaluateSnapshotPayload() async -> (viewport: SurfAceViewport, visibleText: String, selection: SurfAceSelection?)? {
        let script = "window.__surfAceSnapshotPayload ? JSON.stringify(window.__surfAceSnapshotPayload()) : null;"
        guard let object = await evaluateJSONObject(script),
              let viewport = parseViewport(object["viewport"] as? [String: Any]) else {
            return nil
        }

        let visibleText = (object["visibleText"] as? String) ?? ""
        var selection: SurfAceSelection?
        if let selectionObject = object["selection"] as? [String: Any],
           let text = selectionObject["text"] as? String,
           let rect = parseRect(selectionObject["boundingRect"] as? [String: Any]) {
            selection = .text(text, boundingRect: rect.surfAceRect)
        }

        return (viewport, visibleText, selection)
    }

    private func evaluateJSONObject(_ script: String) async -> [String: Any]? {
        await withCheckedContinuation { continuation in
            webView.evaluateJavaScript(script) { result, _ in
                guard let json = result as? String,
                      let data = json.data(using: .utf8),
                      let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                    continuation.resume(returning: nil)
                    return
                }
                continuation.resume(returning: object)
            }
        }
    }

    private func evaluateJavaScriptVoid(_ script: String) async {
        await withCheckedContinuation { continuation in
            webView.evaluateJavaScript(script) { _, _ in
                continuation.resume()
            }
        }
    }

    private func beginPendingHTMLRender() {
        finishPendingHTMLRender()
        pendingHTMLRenderTask = Task { @MainActor [weak self] in
            await withCheckedContinuation { continuation in
                self?.pendingHTMLRenderContinuation = continuation
            }
        }
    }

    private func waitForPendingHTMLRenderIfNeeded() async {
        await pendingHTMLRenderTask?.value
    }

    private func finishPendingHTMLRender() {
        pendingHTMLRenderContinuation?.resume()
        pendingHTMLRenderContinuation = nil
        pendingHTMLRenderTask = nil
    }

    private func restorePendingViewportIfNeeded() async {
        guard let viewport = pendingViewportRestore else { return }
        pendingViewportRestore = nil

        let script = """
        (function() {
          const doc = document.documentElement;
          const body = document.body;
          const maxX = Math.max(
            (doc ? doc.scrollWidth : 0),
            (body ? body.scrollWidth : 0),
            window.innerWidth || 0
          ) - (window.innerWidth || 0);
          const maxY = Math.max(
            (doc ? doc.scrollHeight : 0),
            (body ? body.scrollHeight : 0),
            window.innerHeight || 0
          ) - (window.innerHeight || 0);
          window.scrollTo(
            Math.max(0, Math.min(\(viewport.scrollOffset.x), Math.max(maxX, 0))),
            Math.max(0, Math.min(\(viewport.scrollOffset.y), Math.max(maxY, 0)))
          );
        })();
        """
        await evaluateJavaScriptVoid(script)
    }

    private func publishCurrentWebViewportIfNeeded() async {
        guard case .some(.html) = currentEntry?.payload else { return }
        guard let payload = await evaluateSnapshotPayload() else { return }
        lastViewport = payload.viewport
        lastVisibleText = payload.visibleText
        lastSelection = payload.selection ?? lastSelection
        onScrollSettled?(payload.viewport, payload.visibleText)
    }

    private func parseViewport(_ object: [String: Any]?) -> SurfAceViewport? {
        guard let object,
              let scrollOffset = parsePoint(object["scrollOffset"] as? [String: Any]),
              let visibleRect = parseRect(object["visibleRect"] as? [String: Any]),
              let contentSize = parseSize(object["contentSize"] as? [String: Any]),
              let zoomLevel = parseDouble(object["zoomLevel"]) else {
            return nil
        }
        return SurfAceViewport(
            scrollOffset: SurfAcePoint(x: Double(scrollOffset.x), y: Double(scrollOffset.y)),
            visibleRect: visibleRect.surfAceRect,
            contentSize: SurfAceSize(width: Double(contentSize.width), height: Double(contentSize.height)),
            zoomLevel: zoomLevel
        )
    }

    private func parsePoint(_ object: [String: Any]?) -> CGPoint? {
        guard let object,
              let x = parseDouble(object["x"]),
              let y = parseDouble(object["y"]) else {
            return nil
        }
        return CGPoint(x: x, y: y)
    }

    private func parseRect(_ object: [String: Any]?) -> CGRect? {
        guard let object,
              let x = parseDouble(object["x"]),
              let y = parseDouble(object["y"]),
              let width = parseDouble(object["width"]),
              let height = parseDouble(object["height"]) else {
            return nil
        }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private func parseSize(_ object: [String: Any]?) -> CGSize? {
        guard let object,
              let width = parseDouble(object["width"]),
              let height = parseDouble(object["height"]) else {
            return nil
        }
        return CGSize(width: width, height: height)
    }

    private func parseDouble(_ value: Any?) -> Double? {
        if let value = value as? Double { return value }
        if let value = value as? CGFloat { return Double(value) }
        if let value = value as? NSNumber { return value.doubleValue }
        if let value = value as? String { return Double(value) }
        return nil
    }

    private func parseInt64(_ value: Any?) -> Int64? {
        if let value = value as? Int64 { return value }
        if let value = value as? Int { return Int64(value) }
        if let value = value as? NSNumber { return value.int64Value }
        if let value = value as? String { return Int64(value) }
        return nil
    }

    private func captureFullScreenshotBase64() -> String? {
        guard bounds.width > 1, bounds.height > 1 else { return nil }
        let renderer = UIGraphicsImageRenderer(bounds: bounds)
        let image = renderer.image { _ in
            drawHierarchy(in: bounds, afterScreenUpdates: true)
        }
        return image.pngData()?.base64EncodedString()
    }

    private func standbyHTML() -> String {
        idleConstellationHTML(title: "Surface ready", detail: "Waiting for content.")
    }

    private func imageHTML(data: String, mediaType: String, alt: String?) -> String {
        let escapedAlt = escapeHTML(alt ?? "")
        return """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=5.0,user-scalable=yes" />
          <style>
            body { margin: 0; background: #0a0f14; min-height: 100vh; display: flex; align-items: center; justify-content: center; }
            img { max-width: 100%; max-height: 100vh; object-fit: contain; }
          </style>
        </head>
        <body><img alt="\(escapedAlt)" src="data:\(mediaType);base64,\(data)" /></body>
        </html>
        """
    }

    private func videoHTML(url: String) -> String {
        let escapedURL = escapeHTML(url)
        return """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=3.0,user-scalable=yes" />
          <style>
            html, body { margin: 0; min-height: 100%; background: #05080c; }
            body {
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
            }
            video {
              width: 100%;
              max-height: 100vh;
              background: #000;
            }
          </style>
        </head>
        <body>
          <video controls playsinline preload="metadata" src="\(escapedURL)"></video>
        </body>
        </html>
        """
    }

    private func markdownHTML(_ markdown: String) -> String {
        if let attributed = try? AttributedString(markdown: markdown, options: .init(interpretedSyntax: .full)),
           let htmlData = try? NSAttributedString(attributed).data(
               from: NSRange(location: 0, length: NSAttributedString(attributed).length),
               documentAttributes: [.documentType: NSAttributedString.DocumentType.html]
           ),
           let htmlString = String(data: htmlData, encoding: .utf8) {
            return """
            <!doctype html>
            <html><head>
            <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=3.0,user-scalable=yes" />
            <style>
            html, body { margin: 0; padding: 0; background: #0d1218; color: #f3f5f8; font: -apple-system-body; }
            body { padding: 24px; line-height: 1.45; }
            pre { background: #121a22; padding: 14px; border-radius: 10px; overflow: auto; }
            code { font-family: Menlo, monospace; }
            </style></head><body>\(htmlString)</body></html>
            """
        }

        return """
        <!doctype html>
        <html><head>
        <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=3.0,user-scalable=yes" />
        <style>body { margin: 0; padding: 24px; background: #0d1218; color: #f3f5f8; font-family: -apple-system; white-space: pre-wrap; }</style>
        </head><body>\(escapeHTML(markdown))</body></html>
        """
    }

    private func placeholderHTML(title: String, detail: String, backgroundCSS: String = "#0a0f14") -> String {
        let escapedTitle = escapeHTML(title)
        let escapedDetail = escapeHTML(detail)
        return """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0" />
          <style>
            html, body { margin: 0; min-height: 100%; background: \(backgroundCSS); color: #f3f5f8; }
            body {
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
              font-family: -apple-system, BlinkMacSystemFont, sans-serif;
            }
            .card {
              max-width: 320px;
              padding: 20px 22px;
              border-radius: 18px;
              background: rgba(0, 0, 0, 0.34);
              text-align: center;
            }
            h1 { margin: 0 0 8px; font-size: 20px; }
            p { margin: 0; line-height: 1.4; color: rgba(243, 245, 248, 0.78); }
          </style>
        </head>
        <body>
          <div class="card">
            <h1>\(escapedTitle)</h1>
            <p>\(escapedDetail)</p>
          </div>
        </body>
        </html>
        """
    }

    private func idleConstellationHTML(title: String, detail: String) -> String {
        let escapedTitle = escapeHTML(title)
        let escapedDetail = escapeHTML(detail)
        return """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0" />
          <style>
            html, body {
              margin: 0;
              min-height: 100%;
              background: #000;
              color: #edf8f2;
              overflow: hidden;
            }
            body {
              min-height: 100vh;
              display: grid;
              place-items: center;
              padding: 24px;
              position: relative;
              text-align: center;
              font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            }
            .idle {
              position: absolute;
              inset: 0;
              isolation: isolate;
            }
            canvas {
              position: absolute;
              inset: 0;
              width: 100%;
              height: 100%;
              display: block;
              z-index: 0;
            }
            .copy {
              position: relative;
              z-index: 1;
              max-width: 32ch;
              padding: 24px 28px;
              border-radius: 18px;
              background: rgba(0, 0, 0, 0.28);
              border: 1px solid rgba(130, 199, 255, 0.18);
              backdrop-filter: blur(14px);
            }
            h1 {
              margin: 0 0 8px;
              color: #f7fbff;
              font-size: 20px;
              font-weight: 300;
              letter-spacing: 0.14em;
              text-transform: uppercase;
            }
            p {
              margin: 0;
              color: rgba(237, 248, 242, 0.72);
              font-size: 14px;
              font-weight: 500;
              letter-spacing: 0.1em;
              text-transform: uppercase;
              line-height: 1.45;
            }
          </style>
        </head>
        <body>
          <div class="idle">
            <canvas id="constellation"></canvas>
          </div>
          <div class="copy">
            <h1>\(escapedTitle)</h1>
            <p>\(escapedDetail)</p>
          </div>
          <script>
            (function() {
              const canvas = document.getElementById("constellation");
              const host = document.body;
              if (!canvas || !host) {
                return;
              }

              const context = canvas.getContext("2d");
              if (!context) {
                return;
              }

              const particleCount = 120;
              const connectionDistance = 100;
              const maxSpeed = 0.22;
              const particles = [];
              let width = 1;
              let height = 1;

              function randomBetween(min, max) {
                return min + Math.random() * (max - min);
              }

              function seedParticle() {
                return {
                  alpha: randomBetween(0.55, 0.95),
                  hue: randomBetween(180, 240),
                  radius: randomBetween(1.4, 3.4),
                  vx: randomBetween(-maxSpeed, maxSpeed),
                  vy: randomBetween(-maxSpeed, maxSpeed),
                  x: randomBetween(0, width),
                  y: randomBetween(0, height)
                };
              }

              function resize() {
                const rect = host.getBoundingClientRect();
                width = Math.max(1, Math.floor(rect.width));
                height = Math.max(1, Math.floor(rect.height));
                const dpr = window.devicePixelRatio || 1;
                canvas.width = Math.max(1, Math.floor(width * dpr));
                canvas.height = Math.max(1, Math.floor(height * dpr));
                canvas.style.width = width + "px";
                canvas.style.height = height + "px";
                context.setTransform(dpr, 0, 0, dpr, 0, 0);
              }

              resize();
              for (let index = 0; index < particleCount; index += 1) {
                particles.push(seedParticle());
              }

              function draw() {
                resize();
                context.clearRect(0, 0, width, height);
                context.fillStyle = "#000";
                context.fillRect(0, 0, width, height);

                for (const particle of particles) {
                  particle.x += particle.vx;
                  particle.y += particle.vy;
                  if (particle.x <= 0 || particle.x >= width) {
                    particle.vx *= -1;
                    particle.x = Math.max(0, Math.min(width, particle.x));
                  }
                  if (particle.y <= 0 || particle.y >= height) {
                    particle.vy *= -1;
                    particle.y = Math.max(0, Math.min(height, particle.y));
                  }
                }

                for (let left = 0; left < particles.length; left += 1) {
                  const source = particles[left];
                  for (let right = left + 1; right < particles.length; right += 1) {
                    const target = particles[right];
                    const dx = target.x - source.x;
                    const dy = target.y - source.y;
                    const distance = Math.hypot(dx, dy);
                    if (distance > connectionDistance) {
                      continue;
                    }
                    const intensity = 1 - distance / connectionDistance;
                    const hue = (source.hue + target.hue) / 2;
                    context.beginPath();
                    context.moveTo(source.x, source.y);
                    context.lineTo(target.x, target.y);
                    context.strokeStyle = "hsla(" + hue + ", 90%, 70%, " + (0.1 + intensity * 0.3) + ")";
                    context.lineWidth = 0.7 + intensity * 0.9;
                    context.shadowBlur = 12 * intensity;
                    context.shadowColor = "hsla(" + hue + ", 100%, 72%, " + (0.35 * intensity) + ")";
                    context.stroke();
                  }
                }

                context.shadowBlur = 0;
                for (const particle of particles) {
                  context.beginPath();
                  context.fillStyle = "hsla(" + particle.hue + ", 100%, 72%, " + particle.alpha + ")";
                  context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
                  context.shadowBlur = 14;
                  context.shadowColor = "hsla(" + particle.hue + ", 100%, 72%, " + (particle.alpha * 0.5) + ")";
                  context.fill();
                }
                context.shadowBlur = 0;

                window.requestAnimationFrame(draw);
              }

              window.requestAnimationFrame(draw);
            })();
          </script>
        </body>
        </html>
        """
    }

    private func terminalHTML(lines: [String]) -> String {
        let renderedLines = lines.map(SurfAceANSI.html).joined(separator: "<br/>")
        return """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=3.0,user-scalable=yes" />
          <style>
            html, body { margin: 0; padding: 0; background: #0a0f14; color: #d4e8ff; }
            pre { margin: 0; padding: 18px; font-family: Menlo, SFMono-Regular, ui-monospace, monospace; font-size: 14px; line-height: 1.4; white-space: pre-wrap; word-break: break-word; }
          </style>
        </head>
        <body><pre>\(renderedLines)</pre></body>
        </html>
        """
    }

    private func escapeHTML(_ string: String) -> String {
        string
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }

    private func extractPDFText(_ base64Data: String) -> String {
        guard let decoded = Data(base64Encoded: base64Data, options: [.ignoreUnknownCharacters]),
              let document = PDFDocument(data: decoded) else {
            return ""
        }
        return document.string ?? ""
    }

    private func randomStrokeID() -> String {
        var bytes = [UInt8](repeating: 0, count: 8)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let hex: String
        if status == errSecSuccess {
            hex = bytes.map { String(format: "%02x", $0) }.joined()
        } else {
            hex = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        }
        return "stroke_\(hex)"
    }

    private func bridgeScript() -> String {
        #"""
        (function() {
          if (window.__surfAceBridgeInstalled) { return; }
          window.__surfAceBridgeInstalled = true;
          window.__surfAceScrollDebounce = 500;

          function cleanText(input) {
            return String(input || '').replace(/\s+/g, ' ').trim().slice(0, 4096);
          }

          function collectVisibleText() {
            const root = document.body || document.documentElement;
            function stripCssNoise(text) {
              return cleanText(String(text || '')
                .replace(/\/\*[\s\S]*?\*\//g, ' ')
                .replace(/\b[a-zA-Z0-9_.#:-]+\s*\{[^{}]*\}/g, ' '));
            }
            function extractFromSanitizedClone() {
              if (!root || !root.cloneNode) return '';
              const clone = root.cloneNode(true);
              if (!clone || !clone.querySelectorAll) return '';
              clone.querySelectorAll('style,script,noscript,template').forEach(function(el) { el.remove(); });
              return stripCssNoise(clone.innerText || '');
            }
            const sanitized = extractFromSanitizedClone();
            if (sanitized) return sanitized.slice(0, 4096);
            return stripCssNoise((document.body && document.body.innerText) || document.documentElement.innerText || '').slice(0, 4096);
          }

          function currentSelection() {
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
            const text = cleanText(selection.toString());
            if (!text) return null;
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            return {
              kind: 'text',
              text: text,
              boundingRect: {
                x: rect.x + window.scrollX,
                y: rect.y + window.scrollY,
                width: rect.width,
                height: rect.height
              }
            };
          }

          window.__surfAceSnapshotPayload = function() {
            return {
              viewport: {
                scrollOffset: { x: window.scrollX || 0, y: window.scrollY || 0 },
                visibleRect: { x: window.scrollX || 0, y: window.scrollY || 0, width: window.innerWidth || 0, height: window.innerHeight || 0 },
                contentSize: {
                  width: Math.max(document.documentElement.scrollWidth || 0, document.body ? document.body.scrollWidth : 0),
                  height: Math.max(document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight : 0)
                },
                zoomLevel: (window.visualViewport && window.visualViewport.scale) || 1
              },
              visibleText: collectVisibleText(),
              selection: currentSelection()
            };
          };

          function postSelectionIfAvailable() {
            const payload = window.__surfAceSnapshotPayload();
            if (payload && payload.selection && window.webkit?.messageHandlers?.surfAceSelection) {
              window.webkit.messageHandlers.surfAceSelection.postMessage(payload.selection);
            }
          }

          let scrollTimer = null;
          function postScrollSettled() {
            const payload = window.__surfAceSnapshotPayload();
            if (window.webkit?.messageHandlers?.surfAceScroll) {
              window.webkit.messageHandlers.surfAceScroll.postMessage(payload);
            }
          }

          function postTap(event, kind) {
            if (!event) return;
            const payload = {
              kind: kind,
              position: { x: (event.clientX || 0) + (window.scrollX || 0), y: (event.clientY || 0) + (window.scrollY || 0) },
              nearestContent: cleanText(event.target && event.target.innerText ? event.target.innerText : '').slice(0, 4096)
            };
            if (window.webkit?.messageHandlers?.surfAceTap) {
              window.webkit.messageHandlers.surfAceTap.postMessage(payload);
            }
          }

          function postNavigation(url) {
            if (!url) return;
            if (window.webkit?.messageHandlers?.surfAceNavigation) {
              window.webkit.messageHandlers.surfAceNavigation.postMessage({ url: String(url), sentAt: Date.now() });
            }
          }

          function postFocus() {
            if (window.webkit?.messageHandlers?.surfAceFocus) {
              window.webkit.messageHandlers.surfAceFocus.postMessage({});
            }
          }

          document.addEventListener('pointerdown', postFocus, { capture: true, passive: true });
          document.addEventListener('selectionchange', postSelectionIfAvailable);
          document.addEventListener('click', function(event) {
            const anchor = event && event.target && event.target.closest ? event.target.closest('a[href]') : null;
            if (anchor && anchor.href) {
              postNavigation(anchor.href);
              return;
            }
            postTap(event, 'tap');
          }, { passive: true });
          document.addEventListener('contextmenu', function(event) {
            postTap(event, 'long_press');
            event.preventDefault();
          });
          window.addEventListener('scroll', function() {
            clearTimeout(scrollTimer);
            scrollTimer = setTimeout(postScrollSettled, window.__surfAceScrollDebounce || 500);
          }, { passive: true });
        })();
        """#
    }
}
