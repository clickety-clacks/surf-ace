import Foundation

/// Presentation of a rejected request. Deliberately not Codable: it must never
/// enter the accepted pane history, drawing state, or restored content.
struct SurfAceTVHTMLDiagnostic: Equatable {
    static let label = "Shown as text. Apple TV can't display web pages."
    let text: String
    let showsSource: Bool

    init(html: String) {
        if let extracted = Self.extract(html) {
            text = extracted
            showsSource = false
        } else {
            text = html
            showsSource = true
        }
    }

    var warning: String {
        showsSource ? Self.label + " Text extraction failed; showing HTML source." : Self.label
    }

    // A small text tokenizer, not a web renderer. Attributes are never used;
    // quoted '>' characters do not end a tag. Decode entities only after
    // tokenization so escaped markup stays readable text.
    private static func extract(_ html: String) -> String? {
        var cursor = html.startIndex
        var output = ""
        var hiddenElement: String?
        let blocks: Set<String> = ["p", "div", "section", "article", "header", "footer",
                                   "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol",
                                   "li", "blockquote", "pre", "tr", "br", "hr"]
        while cursor < html.endIndex {
            if let hidden = hiddenElement {
                guard let closing = html.range(of: "</\\s*" + hidden + "\\s*>",
                                               options: [.regularExpression, .caseInsensitive],
                                               range: cursor..<html.endIndex) else { break }
                cursor = closing.upperBound
                hiddenElement = nil
                continue
            }
            if html[cursor...].hasPrefix("<!--") {
                guard let end = html[cursor...].range(of: "-->") else { break }
                cursor = end.upperBound
                continue
            }
            guard html[cursor] == "<" else {
                if hiddenElement == nil { output.append(html[cursor]) }
                cursor = html.index(after: cursor)
                continue
            }
            var end = html.index(after: cursor)
            var quote: Character?
            while end < html.endIndex {
                let character = html[end]
                if let currentQuote = quote {
                    if character == currentQuote { quote = nil }
                } else if character == "\"" || character == "'" {
                    quote = character
                } else if character == ">" {
                    break
                }
                end = html.index(after: end)
            }
            guard end < html.endIndex else {
                // An unclosed script/style remains hidden through end of input.
                if hiddenElement != nil { break }
                return nil
            }
            let body = html[html.index(after: cursor)..<end].trimmingCharacters(in: .whitespacesAndNewlines)
            let closing = body.hasPrefix("/")
            let name = body.drop(while: { $0 == "/" || $0.isWhitespace })
                .prefix(while: { $0.isLetter || $0.isNumber }).lowercased()
            cursor = html.index(after: end)
            if let hidden = hiddenElement {
                if closing && name == hidden { hiddenElement = nil }
                continue
            }
            if (name == "script" || name == "style") && !closing {
                hiddenElement = name
                continue
            }
            if blocks.contains(name) {
                output += "\n"
                if name == "li" && !closing { output += "• " }
            } else if name == "td" || name == "th" {
                output += "\t"
            }
        }
        return decodeEntities(output).components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }.joined(separator: "\n")
    }

    private static func decodeEntities(_ text: String) -> String {
        let named = ["amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " "]
        var result = ""
        var cursor = text.startIndex
        while cursor < text.endIndex {
            if text[cursor] == "&", let end = text[cursor...].firstIndex(of: ";") {
                let token = String(text[text.index(after: cursor)..<end])
                var replacement = named[token]
                if token.hasPrefix("#") {
                    let hexadecimal = token.lowercased().hasPrefix("#x")
                    let digits = token.dropFirst(hexadecimal ? 2 : 1)
                    if let number = UInt32(digits, radix: hexadecimal ? 16 : 10),
                       let scalar = UnicodeScalar(number) { replacement = String(scalar) }
                }
                if let replacement {
                    result += replacement
                    cursor = text.index(after: end)
                    continue
                }
            }
            result.append(text[cursor])
            cursor = text.index(after: cursor)
        }
        return result
    }
}
