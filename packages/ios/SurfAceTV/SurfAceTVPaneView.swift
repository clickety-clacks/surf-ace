import SwiftUI
import UIKit
import CoreGraphics

@MainActor
final class SurfAceTVPaneView: UIView, SurfAcePaneBridging {
    let scroll = UIScrollView()
    private let image = UIImageView()
    private let text = UILabel()
    private let drawing = CAShapeLayer()
    private(set) var strokes: [SurfAceStroke] = []
    private var document: CGPDFDocument?
    private var page = 1
    private var scale: CGFloat = 1
    private var renderedEntry: SurfAcePaneEntry?
    var onPage: ((Int, Int) -> Void)?
    var onWarning: ((String) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = .black
        scroll.backgroundColor = .black
        addSubview(scroll)
        scroll.addSubview(image)
        scroll.addSubview(text)
        image.contentMode = .scaleAspectFit
        text.numberOfLines = 0
        text.textColor = .white
        text.font = .systemFont(ofSize: 24)
        drawing.strokeColor = UIColor.systemYellow.cgColor
        drawing.lineWidth = 3
        drawing.fillColor = UIColor.clear.cgColor
        layer.addSublayer(drawing)
    }
    required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

    override func layoutSubviews() {
        super.layoutSubviews()
        scroll.frame = bounds
        image.frame = CGRect(origin: .zero, size: CGSize(width: bounds.width * scale, height: bounds.height * scale))
        let textSize = text.sizeThatFits(CGSize(width: max(1, bounds.width), height: .greatestFiniteMagnitude))
        text.frame = CGRect(origin: .zero, size: CGSize(width: bounds.width, height: max(bounds.height, textSize.height)))
        scroll.contentSize = text.isHidden ? image.frame.size : text.frame.size
        drawing.frame = bounds
    }

    static func validate(_ payload: SurfAceFramePayload) throws {
        switch payload {
        case .image(let encoded, _, _):
            guard let data = Data(base64Encoded: encoded), UIImage(data: data) != nil else {
                throw NativeRenderError.invalidImage
            }
        case .pdf(let encoded):
            _ = try pdf(encoded)
        case .terminal, .markdown: break
        default: throw NativeRenderError.unsupported
        }
    }
    enum NativeRenderError: Error { case invalidImage, invalidPDF, unsupported }
    private static func pdf(_ encoded: String) throws -> CGPDFDocument {
        guard let data = Data(base64Encoded: encoded), let provider = CGDataProvider(data: data as CFData),
              let document = CGPDFDocument(provider), document.isUnlocked, document.numberOfPages > 0 else {
            throw NativeRenderError.invalidPDF
        }
        return document
    }

    func render(entry: SurfAcePaneEntry?, restoreViewport: SurfAceViewport?) {
        guard let payload = entry?.payload else {
            renderedEntry = entry
            document = nil
            image.image = nil
            text.attributedText = nil
            text.text = "Waiting for content"
            image.isHidden = true
            text.isHidden = false
            setNeedsLayout()
            return
        }
        do {
            try Self.validate(payload)
            // Validation precedes every display mutation, including history restore.
            let sameContent = renderedEntry?.contentId == entry?.contentId && renderedEntry?.revision == entry?.revision
            document = nil
            switch payload {
            case .image(let encoded, _, _):
                image.image = UIImage(data: Data(base64Encoded: encoded)!)
                image.isHidden = false
                text.isHidden = true
            case .pdf(let encoded):
                document = try Self.pdf(encoded)
                page = sameContent ? min(page, document?.numberOfPages ?? 1) : 1
                renderPage()
            case .terminal(let lines, _):
                text.attributedText = Self.terminal(lines.joined(separator: "\n"), size: 24 * scale)
                image.isHidden = true
                text.isHidden = false
            case .markdown(let source):
                let formatted = SurfAceTVMarkdown.render(source, scale: scale)
                text.attributedText = formatted.text
                image.isHidden = true
                text.isHidden = false
                if let warning = formatted.warning { onWarning?(warning) }
            default: break
            }
            renderedEntry = entry
            setNeedsLayout()
            if let restoreViewport {
                scroll.contentOffset = CGPoint(x: restoreViewport.scrollOffset.x, y: restoreViewport.scrollOffset.y)
            } else { scroll.contentOffset = .zero }
        } catch { onWarning?("Content could not be rendered: \(error)") }
    }

    private func renderPage() {
        guard let document, let pdfPage = document.page(at: page) else { return }
        let box = pdfPage.getBoxRect(.cropBox)
        let target = CGSize(width: 1600, height: 1600 * box.height / max(1, box.width))
        image.image = UIGraphicsImageRenderer(size: target).image { renderer in
            UIColor.white.setFill()
            renderer.fill(CGRect(origin: .zero, size: target))
            let context = renderer.cgContext
            context.translateBy(x: 0, y: target.height)
            context.scaleBy(x: 1, y: -1)
            context.concatenate(pdfPage.getDrawingTransform(.cropBox, rect: CGRect(origin: .zero, size: target), rotate: 0, preserveAspectRatio: true))
            context.drawPDFPage(pdfPage)
        }
        text.isHidden = true
        image.isHidden = false
        onPage?(page, document.numberOfPages)
        setNeedsLayout()
    }
    func changePage(_ delta: Int) {
        guard let document else { return }
        page = min(document.numberOfPages, max(1, page + delta))
        renderPage()
    }
    func moveViewport(dx: CGFloat, dy: CGFloat) {
        scroll.contentOffset = CGPoint(x: max(0, min(scroll.contentSize.width - bounds.width, scroll.contentOffset.x + dx)), y: max(0, min(scroll.contentSize.height - bounds.height, scroll.contentOffset.y + dy)))
    }
    func setContentScale(_ scale: CGFloat) {
        let previousViewport = viewport
        self.scale = scale
        render(entry: renderedEntry, restoreViewport: previousViewport)
    }
    func setInteraction(annotationMode: Bool, fingerDrawEnabled: Bool) { scroll.isScrollEnabled = !annotationMode }
    func restoreDrawing(from drawingData: Data, strokes: [SurfAceStroke]) -> Bool { restoreDrawingStrokes(strokes) }
    func restoreDrawingStrokes(_ strokes: [SurfAceStroke]) -> Bool { self.strokes = strokes; updateDrawing(); return true }
    func captureDrawingData() -> Data { (try? JSONEncoder().encode(strokes)) ?? Data() }
    func removeDrawingStrokeIDs(_ strokeIDs: [String]) { strokes.removeAll { strokeIDs.contains($0.strokeId) }; updateDrawing() }
    func clearDrawings() { strokes = []; updateDrawing() }
    private func updateDrawing() {
        let path = UIBezierPath()
        for stroke in strokes {
            for (index, point) in stroke.points.enumerated() {
                let position = CGPoint(x: point.x, y: point.y)
                if index == 0 { path.move(to: position) } else { path.addLine(to: position) }
            }
        }
        drawing.path = path.cgPath
    }
    var visibleText: String { text.isHidden ? "" : text.attributedText?.string ?? text.text ?? "" }
    private var viewport: SurfAceViewport {
        .init(scrollOffset: .init(x: scroll.contentOffset.x, y: scroll.contentOffset.y), visibleRect: .init(x: scroll.contentOffset.x, y: scroll.contentOffset.y, width: bounds.width, height: bounds.height), contentSize: .init(width: scroll.contentSize.width, height: scroll.contentSize.height), zoomLevel: Double(scale))
    }
    func fetchSnapshot() async -> SurfAceSurfaceSnapshot? {
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let snapshot = UIGraphicsImageRenderer(bounds: bounds).image { layer.render(in: $0.cgContext) }
        return .init(viewport: viewport, selection: nil, imageBase64: snapshot.pngData()?.base64EncodedString())
    }
    func fetchAnnotationBackgroundSnapshot() async -> SurfAceSurfaceSnapshot? {
        drawing.isHidden = true
        defer { drawing.isHidden = false }
        return await fetchSnapshot()
    }
    func fetchSnapshotMetadata() async -> SurfAceSurfaceSnapshot? { .init(viewport: viewport, selection: nil, imageBase64: nil) }
    func applyHTMLPatch(_ patch: SurfAceFramePatchRequest) async -> SurfAceHTMLPatchResult { .failed("Apple TV cannot display web pages") }
    func renderBrowserURL(entry: SurfAcePaneEntry) async -> SurfAceBrowserNavigationResult { .init(errorMessage: "Apple TV cannot display web pages", status: "failed", url: entry.url ?? "") }

    private static func terminal(_ source: String, size: CGFloat) -> NSAttributedString {
        let result = NSMutableAttributedString()
        let palette: [UIColor] = [.black, .systemRed, .systemGreen, .systemYellow, .systemBlue, .systemPurple, .systemTeal, .white]
        var color = UIColor.white
        var bold = false
        let pattern = try! NSRegularExpression(pattern: "\u{001B}\\[([0-9;]*)m")
        let range = NSRange(source.startIndex..., in: source)
        var position = 0
        let string = source as NSString
        func append(_ range: NSRange) {
            let font = UIFont.monospacedSystemFont(ofSize: size, weight: bold ? .bold : .regular)
            result.append(NSAttributedString(string: string.substring(with: range), attributes: [.font: font, .foregroundColor: color]))
        }
        for match in pattern.matches(in: source, range: range) {
            append(NSRange(location: position, length: match.range.location - position))
            let values = string.substring(with: match.range(at: 1))
            for code in (values.isEmpty ? [0] : values.split(separator: ";").compactMap { Int($0) }) {
                switch code {
                case 0: color = .white; bold = false
                case 1: bold = true
                case 30...37: color = palette[code - 30]
                case 90...97: color = palette[code - 90]
                default: break
                }
            }
            position = NSMaxRange(match.range)
        }
        append(NSRange(location: position, length: string.length - position))
        return result
    }
}
