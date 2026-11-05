import XCTest
@testable import SurfAce

final class SurfAceTVHTMLDiagnosticTests: XCTestCase {
    func testHeadingListAndLinkTextRetainReadableStructure() {
        let diagnostic = SurfAceTVHTMLDiagnostic(html: "<h1>Title</h1><p>Read <a href='https://example.com'>this</a>.</p><ul><li>One</li><li>Two</li></ul>")
        XCTAssertEqual(diagnostic.text, "Title\nRead this.\n• One\n• Two")
        XCTAssertEqual(diagnostic.warning, "Shown as text. Apple TV can't display web pages.")
        XCTAssertFalse(diagnostic.showsSource)
    }

    func testScriptsStylesCommentsAndAttributeValuesAreNotText() {
        let diagnostic = SurfAceTVHTMLDiagnostic(html: "<STYLE>p {color:red}</STYLE><!--hidden--><h1 title='a > b'>Visible</h1><script>document.write('hidden')</script><p>After</p>")
        XCTAssertEqual(diagnostic.text, "Visible\nAfter")
        XCTAssertFalse(diagnostic.showsSource)
    }

    func testUnclosedScriptRemainsHidden() {
        let diagnostic = SurfAceTVHTMLDiagnostic(html: "<p>Visible</p><script>if (a < b) hidden")
        XCTAssertEqual(diagnostic.text, "Visible")
        XCTAssertFalse(diagnostic.showsSource)
    }

    func testScriptComparisonsDoNotConsumeFollowingVisibleText() {
        let diagnostic = SurfAceTVHTMLDiagnostic(html: "<p>Before</p><script>if (a < b) x = '>';</script><p>After</p>")
        XCTAssertEqual(diagnostic.text, "Before\nAfter")
    }

    func testEntitiesAreDecodedAfterTagsAreRemoved() {
        let diagnostic = SurfAceTVHTMLDiagnostic(html: "<p>&lt;strong&gt; &amp; &#65; &#x1F642; &unknown;</p>")
        XCTAssertEqual(diagnostic.text, "<strong> & A 🙂 &unknown;")
    }

    func testUnterminatedTagLabelsRawSourceFallback() {
        let source = "<h1 title='unfinished"
        let diagnostic = SurfAceTVHTMLDiagnostic(html: source)
        XCTAssertEqual(diagnostic.text, source)
        XCTAssertTrue(diagnostic.showsSource)
        XCTAssertTrue(diagnostic.warning.contains("showing HTML source"))
    }
}
