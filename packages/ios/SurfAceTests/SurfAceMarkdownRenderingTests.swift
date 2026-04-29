import XCTest
@testable import SurfAce

final class SurfAceMarkdownRenderingTests: XCTestCase {
    func testMarkdownRendersDocumentBlocks() {
        let html = surfAceMarkdownToHTML(
            """
            # Title

            A **bold** paragraph with [a link](https://example.com) and `code`.

            - one
            - two

            > quoted

            ```
            <tag>
            ```

            | Name | Value |
            | --- | --- |
            | A | B |
            """
        )

        XCTAssertTrue(html.contains("<h1>Title</h1>"))
        XCTAssertTrue(html.contains("<strong>bold</strong>"))
        XCTAssertTrue(html.contains("<a data-href=\"https://example.com\" title=\"https://example.com\">a link</a>"))
        XCTAssertTrue(html.contains("<code>code</code>"))
        XCTAssertTrue(html.contains("<ul><li>one</li><li>two</li></ul>"))
        XCTAssertTrue(html.contains("<blockquote><p>quoted</p></blockquote>"))
        XCTAssertTrue(html.contains("<pre><code>&lt;tag&gt;</code></pre>"))
        XCTAssertTrue(html.contains("<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>A</td><td>B</td></tr></tbody></table>"))
    }

    func testMarkdownEscapesRawHTMLSource() {
        XCTAssertEqual(
            surfAceMarkdownToHTML("Hello <script>alert(1)</script>"),
            "<p>Hello &lt;script&gt;alert(1)&lt;/script&gt;</p>"
        )
    }

    func testMarkdownLinksAreInert() {
        let html = surfAceMarkdownToHTML("[bad](javascript:alert('x'))")

        XCTAssertEqual(html, "<p><a data-href=\"javascript:alert(&#39;x&#39;\" title=\"javascript:alert(&#39;x&#39;\">bad</a>)</p>")
        XCTAssertFalse(html.contains(" href="))
    }
}
