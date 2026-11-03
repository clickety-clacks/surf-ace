import XCTest
import UIKit
import CoreGraphics
@testable import SurfAce

@MainActor
final class SurfAceTVRenderingTests: XCTestCase {
    func testInvalidImagesAreRejectedBeforeRendering() {
        XCTAssertThrowsError(try SurfAceTVPaneView.validate(.image(data: "bm90IGFuIGltYWdl", mediaType: "image/png", alt: nil)))
    }
    func testInvalidPDFsAreRejectedBeforeRendering() {
        XCTAssertThrowsError(try SurfAceTVPaneView.validate(.pdf(data: "bm90IGEgcGRm")))
    }
    func testUnsupportedTypesAreNotNativeContent() {
        XCTAssertThrowsError(try SurfAceTVPaneView.validate(.html(html: "<h1>Hello</h1>", baseURL: nil)))
        XCTAssertThrowsError(try SurfAceTVPaneView.validate(.video(url: "https://example.com/video")))
        XCTAssertThrowsError(try SurfAceTVPaneView.validate(.canvas(color: nil, grid: false)))
    }

    func testSupportedContentRendersAndCapturesOnMountedView() async throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 80, height: 160)).image { context in
            UIColor.red.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 80, height: 160))
        }
        let payloads: [(SurfAceContentType, SurfAceFramePayload)] = [
            (.image, .image(data: try XCTUnwrap(image.pngData()).base64EncodedString(), mediaType: "image/png", alt: "Portrait")),
            (.terminal, .terminal(lines: ["\u{001B}[31mred\u{001B}[0m", "second line"], scrollback: 200)),
            (.markdown, .markdown(markdown: "# Heading\n\n**Bold** and `code`\n- item\n| A | B |\n|---|---|\n| 1 | 2 |")),
            (.pdf, .pdf(data: try makePDF().base64EncodedString()))
        ]
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 960, height: 540))
        let controller = UIViewController()
        window.rootViewController = controller
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        let view = SurfAceTVPaneView(frame: window.bounds)
        controller.view.addSubview(view)
        var captures: Set<String> = []
        var selectedPage: Int?
        view.onPage = { selectedPage = $0; XCTAssertEqual($1, 2) }
        for (type, payload) in payloads {
            try SurfAceTVPaneView.validate(payload)
            let frame = SurfAceFrame(contentId: "ct_12345678", revision: 1, contentType: type,
                                     payload: payload, reloadSource: nil, title: nil,
                                     scrollable: true, interactive: false)
            view.render(entry: SurfAcePaneEntry.from(frame: frame), restoreViewport: nil)
            view.layoutIfNeeded()
            let snapshot = await view.fetchSnapshot()
            let capture = try XCTUnwrap(snapshot?.imageBase64)
            let renderedImage = try XCTUnwrap(UIImage(data: try XCTUnwrap(Data(base64Encoded: capture))))
            let attachment = XCTAttachment(image: renderedImage)
            attachment.name = "TV-native-\(type.rawValue)"
            attachment.lifetime = .keepAlways
            add(attachment)
            captures.insert(capture)
            if type == .pdf {
                view.changePage(1)
                let second = await view.fetchSnapshot()
                XCTAssertNotEqual(second?.imageBase64, capture)
                XCTAssertEqual(selectedPage, 2)
                view.setContentScale(1.5)
                XCTAssertEqual(selectedPage, 2)
            }
        }
        XCTAssertEqual(captures.count, payloads.count)
    }

    private func makePDF() throws -> Data {
        let data = NSMutableData()
        let consumer = try XCTUnwrap(CGDataConsumer(data: data))
        var bounds = CGRect(x: 0, y: 0, width: 300, height: 400)
        let context = try XCTUnwrap(CGContext(consumer: consumer, mediaBox: &bounds, nil))
        for color in [UIColor.red, UIColor.blue] {
            context.beginPDFPage(nil)
            context.setFillColor(color.cgColor)
            context.fill(bounds)
            context.endPDFPage()
        }
        context.closePDF()
        return data as Data
    }
}
