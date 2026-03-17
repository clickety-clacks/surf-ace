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
                onConnect: { key in
                    Task { @MainActor in
                        sceneKey = key
                        let surface = runtime.registerSurface(sceneKey: key)
                        surfaceId = surface.surfaceId
                    }
                },
                onDisconnect: { key in
                    Task { @MainActor in
                        runtime.unregisterSurface(sceneKey: key)
                        if sceneKey == key {
                            sceneKey = nil
                            surfaceId = nil
                        }
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

                if surface.labelsVisible, !surface.windowLabel.isEmpty {
                    Text(surface.windowLabel)
                        .font(.system(size: 28, weight: .bold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.92))
                        .padding(.horizontal, 20)
                        .padding(.vertical, 8)
                        .background(.black.opacity(0.44), in: Capsule())
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
                        ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                            SurfAcePaneTreeView(runtime: runtime, surface: surface, node: child)
                        }
                    }
                } else {
                    VStack(spacing: 1) {
                        ForEach(Array(children.enumerated()), id: \.offset) { _, child in
                            SurfAcePaneTreeView(runtime: runtime, surface: surface, node: child)
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
                    Text(pane.labelText)
                        .font(.system(size: 48, weight: .bold, design: .rounded))
                        .foregroundStyle(.white.opacity(0.22))
                        .allowsHitTesting(false)
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
                SurfAceAnnotationBorder(active: pane.annotationMode, pulsing: pane.isDrawingFlushSending)
            }
            .onChange(of: proxy.size) { _, newSize in
                pane.lastMeasuredSize = newSize
            }
        }
        .clipped()
    }
}

private struct SurfAcePaneControls: View {
    let runtime: SurfAceRuntime
    @Bindable var surface: SurfAceSurfaceModel
    @Bindable var pane: SurfAcePaneModel

    var body: some View {
        HStack(spacing: 12) {
            Button(pane.labelText) {
                runtime.toggleLabelsVisibility(surfaceId: surface.surfaceId)
            }
            .buttonStyle(SurfAceGlassButtonStyle())

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
                self.runtime.noteInteraction(surfaceId: self.surfaceId)
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

        func render(entry: SurfAcePaneEntry?) {
            hostView?.render(entry: entry)
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
    var onConnect: (@Sendable (String) -> Void)?
    var onDisconnect: (@Sendable (String) -> Void)?
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
              let sceneKey = view.window?.windowScene?.session.persistentIdentifier else {
            return
        }
        connectedSceneKey = sceneKey
        onConnect?(sceneKey)
    }

    deinit {
        if let connectedSceneKey {
            onDisconnect?(connectedSceneKey)
        }
    }
}

private struct SurfAceSceneProbeRepresentable: UIViewControllerRepresentable {
    let onConnect: @Sendable (String) -> Void
    let onDisconnect: @Sendable (String) -> Void

    func makeUIViewController(context: Context) -> SurfAceSceneProbeController {
        let controller = SurfAceSceneProbeController()
        controller.view.isHidden = true
        controller.onConnect = onConnect
        controller.onDisconnect = onDisconnect
        return controller
    }

    func updateUIViewController(_ uiViewController: SurfAceSceneProbeController, context: Context) {}
}

@MainActor
final class SurfAceSurfaceHostView: UIView, PKCanvasViewDelegate, WKScriptMessageHandler {
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

    private let webView: WKWebView
    private let pdfView = PDFView()
    private let canvasView = PKCanvasView()
    private var currentEntry: SurfAcePaneEntry?
    private var annotationMode = false
    private var fingerDrawEnabled = false
    private var trackedStrokes: [TrackedStroke] = []
    private var isApplyingProgrammaticDrawingChange = false
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
        config.defaultWebpagePreferences.allowsContentJavaScript = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init(frame: frame)
        setupViewHierarchy()
        setupScripts()
        setupPDFTracking()
        render(entry: nil)
    }

    required init?(coder: NSCoder) {
        nil
    }

    deinit {
        NotificationCenter.default.removeObserver(self)
    }

    func render(entry: SurfAcePaneEntry?) {
        currentEntry = entry
        let html: String
        let baseURL: URL?

        if let entry {
            switch entry.payload {
            case .html(let rawHTML, let suppliedBaseURL):
                html = rawHTML
                baseURL = suppliedBaseURL.flatMap(URL.init(string:))
                showWebView()
            case .image(let data, let mediaType, let alt):
                html = imageHTML(data: data, mediaType: mediaType, alt: alt)
                baseURL = nil
                showWebView()
            case .pdf(let data):
                renderPDF(data)
                applyCurrentInteractionState()
                return
            case .terminal(let lines, _):
                html = terminalHTML(lines: lines)
                baseURL = nil
                showWebView()
            case .markdown(let markdown):
                html = markdownHTML(markdown)
                baseURL = nil
                showWebView()
            case .video(let url):
                html = videoPlaceholderHTML(url: url)
                baseURL = nil
                showWebView()
            case .canvas(let color, let grid):
                html = canvasPlaceholderHTML(color: color, grid: grid)
                baseURL = nil
                showWebView()
            case nil:
                html = standbyHTML()
                baseURL = nil
                showWebView()
            }
        } else {
            html = standbyHTML()
            baseURL = nil
            showWebView()
        }

        webView.loadHTMLString(html, baseURL: baseURL)
        applyCurrentInteractionState()
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
        let imageBase64 = includeImage ? captureFullScreenshotBase64() : nil

        switch currentEntry?.payload {
        case .html:
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
        case .video, .canvas:
            if let payload = await evaluateSnapshotPayload() {
                lastViewport = payload.viewport
            }
            lastVisibleText = ""
            lastSelection = nil
        case nil:
            break
        }

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
        let script = WKUserScript(source: bridgeScript(), injectionTime: .atDocumentEnd, forMainFrameOnly: false)
        let controller = webView.configuration.userContentController
        controller.addUserScript(script)
        controller.add(self, name: selectionMessageName)
        controller.add(self, name: scrollMessageName)
        controller.add(self, name: tapMessageName)
        controller.add(self, name: navigationMessageName)
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
        """
        <!doctype html>
        <html><head><meta name="viewport" content="width=device-width,initial-scale=1.0" />
        <style>
        body { margin: 0; background: #0c1116; min-height: 100vh; }
        </style></head><body></body></html>
        """
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

    private func videoPlaceholderHTML(url: String) -> String {
        placeholderHTML(
            title: "Video unavailable",
            detail: "This iOS surface is showing a placeholder for the provider's video content.\n\(url)"
        )
    }

    private func canvasPlaceholderHTML(color: String?, grid: Bool) -> String {
        let background = canvasBackgroundCSS(color: color, grid: grid)
        return placeholderHTML(
            title: "Canvas unavailable",
            detail: "This iOS surface is showing a placeholder for the provider's canvas content.",
            backgroundCSS: background
        )
    }

    private func canvasBackgroundCSS(color: String?, grid: Bool) -> String {
        let trimmedColor = color?.trimmingCharacters(in: .whitespacesAndNewlines)
        let baseColor = (trimmedColor?.isEmpty == false) ? trimmedColor! : "#ffffff"
        guard grid else { return baseColor }
        return """
        linear-gradient(rgba(15, 23, 42, 0.10) 1px, transparent 1px),
        linear-gradient(90deg, rgba(15, 23, 42, 0.10) 1px, transparent 1px),
        \(baseColor)
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
