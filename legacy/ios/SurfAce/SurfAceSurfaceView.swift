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

    var body: some View {
        GeometryReader { proxy in
            ZStack(alignment: .topLeading) {
                SurfAceSurfaceRepresentable(runtime: runtime)
                    .ignoresSafeArea()
                    .background(Color.black.opacity(0.94))
                    .onAppear {
                        runtime.updateViewport(size: proxy.size, scale: displayScale)
                    }
                    .onChange(of: proxy.size) { _, newSize in
                        runtime.updateViewport(size: newSize, scale: displayScale)
                    }

                if runtime.currentFrame == nil {
                    standbyOverlay
                        .padding(24)
                }

                if runtime.isDrawingFlushSending {
                    flushIndicator
                        .padding(16)
                }
            }
            .overlay(alignment: .topTrailing) {
                statusPanel
                    .padding(12)
            }
        }
    }

    private var standbyOverlay: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(runtime.screenName)
                .font(.system(size: 36, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
            Text("Fingerprint: \(runtime.fingerprint)")
                .font(.system(size: 14, weight: .regular, design: .monospaced))
                .foregroundStyle(.white.opacity(0.7))
            Text("Waiting for frame push")
                .font(.system(size: 15, weight: .medium, design: .rounded))
                .foregroundStyle(.white.opacity(0.8))
        }
        .padding(20)
        .background(.black.opacity(0.5), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var flushIndicator: some View {
        HStack(spacing: 8) {
            Circle()
                .fill(Color.orange)
                .frame(width: 8, height: 8)
            Text("Sending ink")
                .font(.system(size: 12, weight: .semibold, design: .rounded))
                .foregroundStyle(.white.opacity(0.9))
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.black.opacity(0.58), in: Capsule())
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }

    private var statusPanel: some View {
        VStack(alignment: .trailing, spacing: 6) {
            Text(runtime.stateLabel)
                .font(.system(size: 15, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
            Text("Port \(runtime.serverPort)")
                .font(.system(size: 12, weight: .regular, design: .monospaced))
                .foregroundStyle(.white.opacity(0.8))
            if let summary = runtime.lastEventSummary {
                Text(summary)
                    .font(.system(size: 12, weight: .regular, design: .monospaced))
                    .foregroundStyle(.white.opacity(0.72))
            }
            if let error = runtime.lastError {
                Text(error)
                    .font(.system(size: 12, weight: .regular, design: .rounded))
                    .foregroundStyle(.red.opacity(0.9))
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 340)
            }
        }
        .padding(10)
        .background(.black.opacity(0.54), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

struct SurfAceSurfaceRepresentable: UIViewRepresentable {
    let runtime: SurfAceRuntime

    func makeCoordinator() -> Coordinator {
        Coordinator(runtime: runtime)
    }

    func makeUIView(context: Context) -> SurfAceSurfaceHostView {
        let view = SurfAceSurfaceHostView()
        context.coordinator.attach(hostView: view)
        runtime.attachSurfaceBridge(context.coordinator)
        return view
    }

    func updateUIView(_ uiView: SurfAceSurfaceHostView, context: Context) {
        context.coordinator.render(frame: runtime.currentFrame)
    }

    @MainActor
    final class Coordinator: NSObject, SurfAceSurfaceBridging {
        private weak var hostView: SurfAceSurfaceHostView?
        private weak var runtime: SurfAceRuntime?

        init(runtime: SurfAceRuntime) {
            self.runtime = runtime
        }

        func attach(hostView: SurfAceSurfaceHostView) {
            self.hostView = hostView
            hostView.onSelectionChanged = { [weak self] text, rect in
                self?.runtime?.handleSelectionChanged(text: text, rect: rect)
            }
            hostView.onScrollSettled = { [weak self] viewport, visibleText in
                self?.runtime?.handleScrollSettled(viewport: viewport, visibleText: visibleText)
            }
            hostView.onZoomSettled = { [weak self] viewport, visibleText in
                self?.runtime?.handleZoomSettled(viewport: viewport, visibleText: visibleText)
            }
            hostView.onTapEvent = { [weak self] kind, position, nearestContent in
                self?.runtime?.handleTapEvent(kind: kind, position: position, nearestContent: nearestContent)
            }
            hostView.onNavigationEvent = { [weak self] url, sentAt in
                self?.runtime?.handleNavigationEvent(url: url, sentAt: sentAt)
            }
            hostView.onStrokeBatch = { [weak self] strokes in
                self?.runtime?.handleNewStrokes(strokes)
            }
        }

        func render(frame: SurfAceFrame?) {
            hostView?.render(frame: frame)
        }

        func fetchSnapshot(for frame: SurfAceFrame, includeImage: Bool) async -> SurfAceSurfaceSnapshot? {
            await hostView?.fetchSnapshot(for: frame, includeImage: includeImage)
        }

        func applyHTMLPatch(_ patch: SurfAceFramePatchRequest) async -> SurfAceHTMLPatchResult {
            await hostView?.applyHTMLPatch(patch) ?? .failed("surface unavailable")
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
final class SurfAceSurfaceHostView: UIView, PKCanvasViewDelegate, WKScriptMessageHandler {
    var onSelectionChanged: ((String, CGRect?) -> Void)?
    var onScrollSettled: ((SurfAceViewport, String) -> Void)?
    var onZoomSettled: ((SurfAceViewport, String) -> Void)?
    var onTapEvent: ((String, SurfAcePoint, String) -> Void)?
    var onNavigationEvent: ((String, Int64) -> Void)?
    var onStrokeBatch: (([SurfAceStroke]) -> Void)?

    private struct TrackedStroke {
        let strokeId: String
        var stroke: PKStroke
        var signature: String
    }

    private let selectionMessageName = "surfAceSelection"
    private let scrollMessageName = "surfAceScroll"
    private let zoomMessageName = "surfAceZoom"
    private let tapMessageName = "surfAceTap"
    private let navigationMessageName = "surfAceNavigation"

    private let webView: WKWebView
    private let canvasView = PKCanvasView()

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
        render(frame: nil)
    }

    required init?(coder: NSCoder) {
        nil
    }

    func render(frame: SurfAceFrame?) {
        let html: String
        let baseURL: URL?

        if let frame {
            webView.scrollView.isScrollEnabled = frame.scrollable
            webView.isUserInteractionEnabled = frame.interactive
            switch frame.payload {
            case .html(let rawHTML, let suppliedBaseURL):
                html = rawHTML
                if let suppliedBaseURL {
                    baseURL = URL(string: suppliedBaseURL)
                } else {
                    baseURL = nil
                }
            case .image(let data, let mediaType, let alt):
                html = imageHTML(data: data, mediaType: mediaType, alt: alt)
                baseURL = nil
            case .pdf(let data):
                html = pdfHTML(data: data)
                baseURL = nil
            case .terminal(let lines, _):
                html = terminalHTML(lines: lines)
                baseURL = nil
            case .markdown(let markdown):
                html = markdownHTML(markdown)
                baseURL = nil
            }
        } else {
            webView.scrollView.isScrollEnabled = true
            webView.isUserInteractionEnabled = true
            html = standbyHTML()
            baseURL = nil
        }

        webView.loadHTMLString(html, baseURL: baseURL)
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
            "html": patch.html
        ]
        guard let bodyData = try? JSONSerialization.data(withJSONObject: payload.compactMapValues { $0 }),
              let bodyJSON = String(data: bodyData, encoding: .utf8) else {
            return .failed("Patch payload serialization failed")
        }

        let script = """
        (function() {
          const patch = \(bodyJSON);
          const target = document.querySelector(patch.selector);
          if (!target) {
            return { ok: false, reason: "selector_not_found" };
          }
          const html = patch.html || "";
          switch (patch.action) {
            case "replace_inner":
              target.innerHTML = html;
              break;
            case "replace_outer":
              target.outerHTML = html;
              break;
            case "insert_before":
              target.insertAdjacentHTML("beforebegin", html);
              break;
            case "insert_after":
              target.insertAdjacentHTML("afterend", html);
              break;
            case "remove":
              target.remove();
              break;
            default:
              return { ok: false, reason: "invalid_action" };
          }
          return { ok: true, html: document.documentElement.outerHTML };
        })();
        """

        guard let result = await evaluateJavaScript(script) as? [String: Any],
              let ok = result["ok"] as? Bool else {
            return .failed("Patch evaluation failed")
        }

        guard ok else {
            if let reason = result["reason"] as? String, reason == "selector_not_found" {
                return .selectorNotFound
            }
            if let reason = result["reason"] as? String, reason == "invalid_action" {
                return .invalidAction
            }
            return .failed("Patch rejected by renderer")
        }

        guard let updatedHTML = result["html"] as? String else {
            return .failed("Updated html unavailable")
        }
        return .success(updatedHTML: updatedHTML)
    }

    func fetchSnapshot(for frame: SurfAceFrame, includeImage: Bool) async -> SurfAceSurfaceSnapshot? {
        let imageBase64 = includeImage ? captureFullScreenshotBase64() : nil

        // Markdown/textual non-HTML payloads must use source data, not WK text extraction.
        switch frame.payload {
        case .html:
            if let snapshotPayload = await evaluateSnapshotPayload() {
                let visibleText = snapshotPayload.visibleText
                lastViewport = snapshotPayload.viewport
                lastVisibleText = visibleText
                let resolvedSelection = snapshotPayload.selection ?? lastSelection
                lastSelection = resolvedSelection

                return SurfAceSurfaceSnapshot(
                    viewport: snapshotPayload.viewport,
                    visibleText: visibleText.prefix(4096).description,
                    selection: resolvedSelection,
                    imageBase64: imageBase64
                )
            }

            return SurfAceSurfaceSnapshot(
                viewport: lastViewport,
                visibleText: lastVisibleText.prefix(4096).description,
                selection: lastSelection,
                imageBase64: imageBase64
            )
        case .markdown(let markdown):
            lastVisibleText = markdown
            return SurfAceSurfaceSnapshot(
                viewport: lastViewport,
                visibleText: markdown.prefix(4096).description,
                selection: lastSelection,
                imageBase64: imageBase64
            )
        case .image(_, _, let alt):
            let visibleText = alt ?? ""
            lastVisibleText = visibleText
            return SurfAceSurfaceSnapshot(
                viewport: lastViewport,
                visibleText: visibleText.prefix(4096).description,
                selection: lastSelection,
                imageBase64: imageBase64
            )
        case .pdf(let data):
            let visibleText = extractPDFText(data)
            lastVisibleText = visibleText
            return SurfAceSurfaceSnapshot(
                viewport: lastViewport,
                visibleText: visibleText.prefix(4096).description,
                selection: lastSelection,
                imageBase64: imageBase64
            )
        case .terminal(let lines, _):
            let visibleText = lines.suffix(200).map(SurfAceANSI.strip).joined(separator: "\n")
            lastVisibleText = visibleText
            return SurfAceSurfaceSnapshot(
                viewport: lastViewport,
                visibleText: visibleText.prefix(4096).description,
                selection: lastSelection,
                imageBase64: imageBase64
            )
        }
    }

    func removeDrawingStrokeIDs(_ strokeIDs: [String]) {
        guard !strokeIDs.isEmpty else {
            return
        }

        let removeSet = Set(strokeIDs)
        let remaining = trackedStrokes.filter { !removeSet.contains($0.strokeId) }
        guard remaining.count != trackedStrokes.count else {
            return
        }

        trackedStrokes = remaining
        applyDrawing(strokes: remaining.map(\.stroke))
    }

    func clearDrawings() {
        trackedStrokes.removeAll()
        applyDrawing(strokes: [])
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any] else {
            return
        }

        if message.name == selectionMessageName {
            if let text = body["text"] as? String,
               let rect = parseRect(body["boundingRect"] as? [String: Any]) {
                let selection = SurfAceSelection.text(text, boundingRect: rect.surfAceRect)
                lastSelection = selection
                onSelectionChanged?(text, rect)
            }
            return
        }

        if message.name == scrollMessageName {
            guard let viewport = parseViewport(body["viewport"] as? [String: Any]) else {
                return
            }
            let visibleText = (body["visibleText"] as? String) ?? ""
            lastViewport = viewport
            lastVisibleText = visibleText
            onScrollSettled?(viewport, visibleText)
            return
        }

        if message.name == zoomMessageName {
            guard let viewport = parseViewport(body["viewport"] as? [String: Any]) else {
                return
            }
            let visibleText = (body["visibleText"] as? String) ?? ""
            lastViewport = viewport
            lastVisibleText = visibleText
            onZoomSettled?(viewport, visibleText)
            return
        }

        if message.name == tapMessageName {
            guard let position = parsePoint(body["position"] as? [String: Any]) else {
                return
            }
            let nearestContent = (body["nearestContent"] as? String) ?? ""
            let kind = (body["kind"] as? String) == "long_press" ? "long_press" : "tap"
            onTapEvent?(kind, SurfAcePoint(x: Double(position.x), y: Double(position.y)), nearestContent)
            return
        }

        if message.name == navigationMessageName {
            guard let url = body["url"] as? String, !url.isEmpty else {
                return
            }
            let sentAt = parseInt64(body["sentAt"]) ?? Int64(Date().timeIntervalSince1970 * 1000)
            onNavigationEvent?(url, sentAt)
        }
    }

    func canvasViewDrawingDidChange(_ canvasView: PKCanvasView) {
        let changed = syncTrackedStrokes(with: canvasView.drawing.strokes, emitChanges: !isApplyingProgrammaticDrawingChange)
        if !isApplyingProgrammaticDrawingChange, !changed.isEmpty {
            onStrokeBatch?(changed)
        }
    }

    private func setupViewHierarchy() {
        backgroundColor = .black

        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.keyboardDismissMode = .onDrag

        canvasView.translatesAutoresizingMaskIntoConstraints = false
        canvasView.backgroundColor = .clear
        canvasView.isOpaque = false
        canvasView.drawingPolicy = .anyInput
        canvasView.delegate = self
        canvasView.tool = PKInkingTool(.pen, color: .systemOrange, width: 4)

        addSubview(webView)
        addSubview(canvasView)

        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: trailingAnchor),
            webView.topAnchor.constraint(equalTo: topAnchor),
            webView.bottomAnchor.constraint(equalTo: bottomAnchor),
            canvasView.leadingAnchor.constraint(equalTo: leadingAnchor),
            canvasView.trailingAnchor.constraint(equalTo: trailingAnchor),
            canvasView.topAnchor.constraint(equalTo: topAnchor),
            canvasView.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }

    private func setupScripts() {
        let script = WKUserScript(source: bridgeScript(), injectionTime: .atDocumentEnd, forMainFrameOnly: false)
        let controller = webView.configuration.userContentController
        controller.addUserScript(script)
        controller.add(self, name: selectionMessageName)
        controller.add(self, name: scrollMessageName)
        controller.add(self, name: zoomMessageName)
        controller.add(self, name: tapMessageName)
        controller.add(self, name: navigationMessageName)
    }

    private func applyDrawing(strokes: [PKStroke]) {
        isApplyingProgrammaticDrawingChange = true
        canvasView.drawing = PKDrawing(strokes: strokes)
        isApplyingProgrammaticDrawingChange = false
    }

    private func syncTrackedStrokes(with strokes: [PKStroke], emitChanges: Bool) -> [SurfAceStroke] {
        var next: [TrackedStroke] = []
        var changed: [SurfAceStroke] = []
        next.reserveCapacity(strokes.count)

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
        let lastPoint: PKStrokePoint?
        if count > 0 {
            lastPoint = stroke.path[count - 1]
        } else {
            lastPoint = nil
        }
        let x = lastPoint?.location.x ?? 0
        let y = lastPoint?.location.y ?? 0
        let force = lastPoint?.force ?? 0
        return "\(count)-\(x)-\(y)-\(force)-\(stroke.ink.inkType.rawValue)"
    }

    private func serializeStroke(_ stroke: PKStroke, strokeId: String) -> SurfAceStroke {
        let nowMilliseconds = Int64(Date().timeIntervalSince1970 * 1000)
        var points: [SurfAceStrokePoint] = []
        points.reserveCapacity(stroke.path.count)
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
        return SurfAceStroke(strokeId: strokeId, points: points, tool: "pencil")
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

    private func evaluateSnapshotPayload() async -> (viewport: SurfAceViewport, visibleText: String, selection: SurfAceSelection?)? {
        let script = "window.__surfAceSnapshotPayload ? window.__surfAceSnapshotPayload() : null;"
        guard let object = await evaluateJavaScript(script) as? [String: Any],
              let viewport = parseViewport(object["viewport"] as? [String: Any]) else {
            return nil
        }

        let visibleText = (object["visibleText"] as? String) ?? ""
        var selection: SurfAceSelection?
        if let selectionObject = object["selection"] as? [String: Any],
           let kind = selectionObject["kind"] as? String {
            switch kind {
            case "text":
                if let text = selectionObject["text"] as? String,
                   let rect = parseRect(selectionObject["boundingRect"] as? [String: Any]) {
                    selection = .text(text, boundingRect: rect.surfAceRect)
                }
            case "point":
                if let position = parsePoint(selectionObject["position"] as? [String: Any]) {
                    selection = .point(SurfAcePoint(x: Double(position.x), y: Double(position.y)))
                }
            case "region":
                if let rect = parseRect(selectionObject["rect"] as? [String: Any]) {
                    selection = .region(rect.surfAceRect, text: selectionObject["text"] as? String)
                }
            default:
                break
            }
        }

        return (viewport, visibleText, selection)
    }

    private func evaluateJavaScript(_ script: String) async -> Any? {
        await withCheckedContinuation { continuation in
            webView.evaluateJavaScript(script) { result, _ in
                continuation.resume(returning: result)
            }
        }
    }

    private func parseViewport(_ dictionary: [String: Any]?) -> SurfAceViewport? {
        guard let dictionary,
              let scrollOffset = parsePoint(dictionary["scrollOffset"] as? [String: Any]),
              let visibleRect = parseRect(dictionary["visibleRect"] as? [String: Any]),
              let contentSize = parseSize(dictionary["contentSize"] as? [String: Any]) else {
            return nil
        }
        let zoomLevel = parseDouble(dictionary["zoomLevel"]) ?? 1
        return SurfAceViewport(
            scrollOffset: SurfAcePoint(x: Double(scrollOffset.x), y: Double(scrollOffset.y)),
            visibleRect: visibleRect.surfAceRect,
            contentSize: contentSize,
            zoomLevel: zoomLevel
        )
    }

    private func parseSize(_ dictionary: [String: Any]?) -> SurfAceSize? {
        guard let dictionary,
              let width = parseDouble(dictionary["width"]),
              let height = parseDouble(dictionary["height"]) else {
            return nil
        }
        return SurfAceSize(width: width, height: height)
    }

    private func parsePoint(_ dictionary: [String: Any]?) -> CGPoint? {
        guard let dictionary,
              let x = parseDouble(dictionary["x"]),
              let y = parseDouble(dictionary["y"]) else {
            return nil
        }
        return CGPoint(x: x, y: y)
    }

    private func parseRect(_ dictionary: [String: Any]?) -> CGRect? {
        guard let dictionary,
              let x = parseDouble(dictionary["x"]),
              let y = parseDouble(dictionary["y"]),
              let width = parseDouble(dictionary["width"]),
              let height = parseDouble(dictionary["height"]) else {
            return nil
        }
        return CGRect(x: x, y: y, width: width, height: height)
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
        guard bounds.width > 1, bounds.height > 1 else {
            return nil
        }
        let renderer = UIGraphicsImageRenderer(bounds: bounds)
        let image = renderer.image { _ in
            drawHierarchy(in: bounds, afterScreenUpdates: true)
        }
        return image.pngData()?.base64EncodedString()
    }

    private func standbyHTML() -> String {
        """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=1.0,user-scalable=no" />
          <style>
            body {
              margin: 0;
              font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif;
              background: #0c1116;
              color: #f3f5f8;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
            }
          </style>
        </head>
        <body></body>
        </html>
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
            body {
              margin: 0;
              background: #0a0f14;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
            }
            img {
              max-width: 100%;
              max-height: 100vh;
              object-fit: contain;
            }
          </style>
        </head>
        <body>
          <img alt="\(escapedAlt)" src="data:\(mediaType);base64,\(data)" />
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
            <html>
            <head>
              <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=3.0,user-scalable=yes" />
              <style>
                html, body { margin: 0; padding: 0; background: #0d1218; color: #f3f5f8; font: -apple-system-body; }
                body { padding: 24px; line-height: 1.45; }
                pre { background: #121a22; padding: 14px; border-radius: 10px; overflow: auto; }
                code { font-family: Menlo, monospace; }
              </style>
            </head>
            <body>
              \(htmlString)
            </body>
            </html>
            """
        }

        return """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=3.0,user-scalable=yes" />
          <style>
            body { margin: 0; padding: 24px; background: #0d1218; color: #f3f5f8; font-family: -apple-system; white-space: pre-wrap; }
          </style>
        </head>
        <body>\(escapeHTML(markdown))</body>
        </html>
        """
    }

    private func pdfHTML(data: String) -> String {
        """
        <!doctype html>
        <html>
        <head>
          <meta name="viewport" content="width=device-width,initial-scale=1.0,maximum-scale=5.0,user-scalable=yes" />
          <style>
            html, body { margin: 0; height: 100%; background: #0a0f14; }
            embed { width: 100%; height: 100%; border: 0; }
          </style>
        </head>
        <body>
          <embed src="data:application/pdf;base64,\(data)" type="application/pdf" />
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
            pre {
              margin: 0;
              padding: 18px;
              font-family: Menlo, SFMono-Regular, ui-monospace, monospace;
              font-size: 14px;
              line-height: 1.4;
              white-space: pre-wrap;
              word-break: break-word;
            }
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

    private func bridgeScript() -> String {
        #"""
        (function() {
          if (window.__surfAceBridgeInstalled) { return; }
          window.__surfAceBridgeInstalled = true;
          window.__surfAceScrollDebounce = 500;

          function cleanText(input) {
            return String(input || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 4096);
          }

          function collectVisibleText() {
            const maxLength = 4096;
            const root = document.body || document.documentElement;

            function stripCssNoise(text) {
              return cleanText(
                String(text || '')
                  .replace(/\/\*[\s\S]*?\*\//g, ' ')
                  .replace(/\b[a-zA-Z0-9_.#:-]+\s*\{[^{}]*\}/g, ' ')
              );
            }

            function extractFromSanitizedClone() {
              if (!root || !root.cloneNode) return '';
              const clone = root.cloneNode(true);
              if (!clone || !clone.querySelectorAll) return '';
              clone.querySelectorAll('style,script,noscript,template').forEach(function(el) { el.remove(); });
              return stripCssNoise(clone.innerText || '');
            }

            const sanitized = extractFromSanitizedClone();
            if (sanitized) {
              return sanitized.slice(0, maxLength);
            }

            return stripCssNoise((document.body && document.body.innerText) || document.documentElement.innerText || '').slice(0, maxLength);
          }

          function currentSelection() {
            const selection = window.getSelection();
            if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
              return null;
            }
            const text = cleanText(selection.toString());
            if (!text) {
              return null;
            }
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
            const viewport = {
              scrollOffset: { x: window.scrollX || 0, y: window.scrollY || 0 },
              visibleRect: {
                x: window.scrollX || 0,
                y: window.scrollY || 0,
                width: window.innerWidth || 0,
                height: window.innerHeight || 0
              },
              contentSize: {
                width: Math.max(document.documentElement.scrollWidth || 0, document.body ? document.body.scrollWidth : 0),
                height: Math.max(document.documentElement.scrollHeight || 0, document.body ? document.body.scrollHeight : 0)
              },
              zoomLevel: (window.visualViewport && window.visualViewport.scale) || 1
            };

            return {
              viewport: viewport,
              visibleText: collectVisibleText(),
              selection: currentSelection()
            };
          };

          function postSelectionIfAvailable() {
            const payload = window.__surfAceSnapshotPayload();
            if (!payload || !payload.selection) return;
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.surfAceSelection) {
              window.webkit.messageHandlers.surfAceSelection.postMessage(payload.selection);
            }
          }

          let scrollTimer = null;
          function postScrollSettled() {
            const payload = window.__surfAceSnapshotPayload();
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.surfAceScroll) {
              window.webkit.messageHandlers.surfAceScroll.postMessage(payload);
            }
          }

          function postZoomSettled() {
            const payload = window.__surfAceSnapshotPayload();
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.surfAceZoom) {
              window.webkit.messageHandlers.surfAceZoom.postMessage(payload);
            }
          }

          function postTap(event, kind) {
            if (!event) return;
            const x = (event.clientX || 0) + (window.scrollX || 0);
            const y = (event.clientY || 0) + (window.scrollY || 0);
            const targetText = cleanText(event.target && event.target.innerText ? event.target.innerText : '');
            const payload = {
              kind: kind,
              position: { x: x, y: y },
              nearestContent: targetText.slice(0, 4096)
            };
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.surfAceTap) {
              window.webkit.messageHandlers.surfAceTap.postMessage(payload);
            }
          }

          function postNavigation(url) {
            if (!url) return;
            const payload = {
              url: String(url),
              sentAt: Date.now()
            };
            if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.surfAceNavigation) {
              window.webkit.messageHandlers.surfAceNavigation.postMessage(payload);
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

          let zoomTimer = null;
          if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', function() {
              clearTimeout(zoomTimer);
              zoomTimer = setTimeout(postZoomSettled, window.__surfAceScrollDebounce || 500);
            }, { passive: true });
          }
        })();
        """#
    }
}
