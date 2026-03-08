import Foundation

enum SurfAceANSI {
    private static let ansiRegex = #"\u{001B}\[[0-9;]*m"#

    static func strip(_ value: String) -> String {
        value.replacingOccurrences(of: ansiRegex, with: "", options: .regularExpression)
    }

    static func html(_ value: String) -> String {
        var output = ""
        var state = ANSIStyle()
        var index = value.startIndex

        while index < value.endIndex {
            if value[index] == "\u{001B}" {
                let start = index
                index = value.index(after: index)
                guard index < value.endIndex, value[index] == "[" else {
                    output += escapeHTML(String(value[start]))
                    continue
                }
                let payloadStart = value.index(after: index)
                var cursor = payloadStart
                while cursor < value.endIndex, value[cursor] != "m" {
                    cursor = value.index(after: cursor)
                }
                guard cursor < value.endIndex, value[cursor] == "m" else {
                    output += escapeHTML(String(value[start]))
                    index = payloadStart
                    continue
                }
                let payload = String(value[payloadStart..<cursor])
                applyANSICodes(payload, to: &state)
                index = value.index(after: cursor)
                continue
            }

            let char = String(value[index])
            output += state.wrap(escapeHTML(char))
            index = value.index(after: index)
        }

        return output
    }

    private static func applyANSICodes(_ payload: String, to style: inout ANSIStyle) {
        let codes = payload
            .split(separator: ";")
            .compactMap { Int($0) }
        if codes.isEmpty {
            style = ANSIStyle()
            return
        }
        for code in codes {
            switch code {
            case 0:
                style = ANSIStyle()
            case 1:
                style.bold = true
            case 30...37, 90...97:
                style.foreground = colorHex(for: code)
            default:
                break
            }
        }
    }

    private static func colorHex(for code: Int) -> String {
        switch code {
        case 30: return "#111111"
        case 31: return "#ff5f56"
        case 32: return "#27c93f"
        case 33: return "#ffbd2e"
        case 34: return "#56a8ff"
        case 35: return "#bf5af2"
        case 36: return "#32ade6"
        case 37: return "#e5e5e5"
        case 90: return "#7d7d7d"
        case 91: return "#ff8f88"
        case 92: return "#74f28a"
        case 93: return "#ffd66f"
        case 94: return "#89c6ff"
        case 95: return "#d9a8ff"
        case 96: return "#7eddfd"
        case 97: return "#ffffff"
        default: return "#d4e8ff"
        }
    }

    private static func escapeHTML(_ value: String) -> String {
        value
            .replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&#39;")
    }
}

private struct ANSIStyle {
    var foreground: String = "#d4e8ff"
    var bold = false

    func wrap(_ text: String) -> String {
        let weight = bold ? "700" : "400"
        return "<span style=\"color: \(foreground); font-weight: \(weight);\">\(text)</span>"
    }
}
