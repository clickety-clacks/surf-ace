import UIKit

/// Native, non-executing presentation of the markdown content type.
@MainActor
enum SurfAceTVMarkdown {
    struct Result {
        let text: NSAttributedString
        let warning: String?
    }

    static func render(_ source: String, scale: CGFloat) -> Result {
        let output = NSMutableAttributedString()
        var fence: String?
        var warnings: Set<String> = []
        for original in source.components(separatedBy: .newlines) {
            let trimmed = original.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                let marker = String(trimmed.prefix(3))
                if fence == nil { fence = marker; continue }
                if fence == marker { fence = nil; continue }
                // A different marker inside code is part of its literal source.
            }
            var line = original
            var heading = 0
            var quote = false
            var literal = fence != nil
            if !literal {
                let hashes = trimmed.prefix(while: { $0 == "#" }).count
                if (1...6).contains(hashes), trimmed.dropFirst(hashes).first == " " {
                    heading = hashes
                    line = String(trimmed.dropFirst(hashes + 1))
                } else if trimmed.hasPrefix("> ") {
                    quote = true
                    line = String(trimmed.dropFirst(2))
                } else if ["- ", "* ", "+ "].contains(where: trimmed.hasPrefix) {
                    line = "• " + trimmed.dropFirst(2)
                }
                // Tables remain readable literal rows; embedded HTML is never executed.
                if trimmed.contains("|") || trimmed.contains("<") {
                    literal = true
                    warnings.insert("Unsupported formatting is shown as literal text.")
                }
            }
            let size = (heading > 0 ? CGFloat(38 - heading * 2) : 24) * scale
            let paragraph = NSMutableParagraphStyle()
            paragraph.paragraphSpacing = heading > 0 ? 14 * scale : 6 * scale
            paragraph.headIndent = quote ? 24 * scale : 0
            paragraph.firstLineHeadIndent = paragraph.headIndent
            let start = output.length
            if literal {
                output.append(NSAttributedString(string: line, attributes: [
                    .font: UIFont.monospacedSystemFont(ofSize: size, weight: .regular),
                    .foregroundColor: UIColor.white,
                    .backgroundColor: UIColor(white: 0.12, alpha: 1)
                ]))
            } else {
                let inline = (try? AttributedString(markdown: line, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(line)
                for run in inline.runs {
                    let intent = run.inlinePresentationIntent ?? []
                    let code = intent.contains(.code)
                    let bold = heading > 0 || intent.contains(.stronglyEmphasized)
                    var font = code ? UIFont.monospacedSystemFont(ofSize: size, weight: bold ? .bold : .regular)
                                    : UIFont.systemFont(ofSize: size, weight: bold ? .bold : .regular)
                    if intent.contains(.emphasized), let descriptor = font.fontDescriptor.withSymbolicTraits(font.fontDescriptor.symbolicTraits.union(.traitItalic)) {
                        font = UIFont(descriptor: descriptor, size: size)
                    }
                    var attributes: [NSAttributedString.Key: Any] = [.font: font, .foregroundColor: quote ? UIColor.lightGray : UIColor.white]
                    if run.link != nil {
                        attributes[.foregroundColor] = UIColor.systemCyan
                        attributes[.underlineStyle] = NSUnderlineStyle.single.rawValue
                        warnings.insert("Apple TV cannot open web links.")
                    }
                    output.append(NSAttributedString(string: String(inline[run.range].characters), attributes: attributes))
                }
            }
            output.append(NSAttributedString(string: "\n"))
            output.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: start, length: output.length - start))
        }
        if fence != nil { warnings.insert("Unclosed code block is shown as literal text.") }
        return Result(text: output, warning: warnings.isEmpty ? nil : warnings.sorted().joined(separator: " "))
    }
}
