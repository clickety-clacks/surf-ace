import XCTest
import UIKit
@testable import SurfAce

@MainActor
final class SurfAceTVMarkdownTests: XCTestCase {
    func testHeadingsListsAndInlineStylesRemainNativeAndReadable() throws {
        let rendered = SurfAceTVMarkdown.render("# Heading\n- item\n**bold** *italic* `code`", scale: 1)
        XCTAssertEqual(rendered.text.string, "Heading\n• item\nbold italic code\n")
        let heading = try XCTUnwrap(rendered.text.attribute(.font, at: 0, effectiveRange: nil) as? UIFont)
        let body = try XCTUnwrap(rendered.text.attribute(.font, at: 8, effectiveRange: nil) as? UIFont)
        XCTAssertGreaterThan(heading.pointSize, body.pointSize)
        let boldIndex = (rendered.text.string as NSString).range(of: "bold").location
        let italicIndex = (rendered.text.string as NSString).range(of: "italic").location
        let bold = try XCTUnwrap(rendered.text.attribute(.font, at: boldIndex, effectiveRange: nil) as? UIFont)
        let italic = try XCTUnwrap(rendered.text.attribute(.font, at: italicIndex, effectiveRange: nil) as? UIFont)
        XCTAssertTrue(bold.fontDescriptor.symbolicTraits.contains(.traitBold))
        XCTAssertTrue(italic.fontDescriptor.symbolicTraits.contains(.traitItalic))
    }
    func testCodeTablesAndHTMLPreserveLiteralSourceWithWarning() {
        let rendered = SurfAceTVMarkdown.render("```\n**literal**\n```\n| A | B |\n<script>no execution</script>", scale: 1)
        XCTAssertTrue(rendered.text.string.contains("**literal**"))
        XCTAssertTrue(rendered.text.string.contains("| A | B |"))
        XCTAssertTrue(rendered.text.string.contains("<script>no execution</script>"))
        XCTAssertNotNil(rendered.warning)
    }
    func testLinksWarnWithoutInstallingInteractiveURLs() {
        let rendered = SurfAceTVMarkdown.render("Read [this](https://example.com).", scale: 1)
        XCTAssertEqual(rendered.text.string, "Read this.\n")
        XCTAssertTrue(rendered.warning?.contains("cannot open web links") == true)
        XCTAssertNil(rendered.text.attribute(.link, at: 6, effectiveRange: nil))
    }
}
