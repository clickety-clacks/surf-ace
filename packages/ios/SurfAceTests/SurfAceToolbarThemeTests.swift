import SwiftUI
import UIKit
import XCTest
@testable import SurfAce

final class SurfAceToolbarThemeTests: XCTestCase {
    func testToolbarForegroundUsesSemanticDarkInkInLightMode() {
        XCTAssertEqualRGB(
            resolvedRGB(surfAceToolbarForeground(), userInterfaceStyle: .light),
            RGB(red: 0, green: 0, blue: 0)
        )
    }

    func testToolbarForegroundUsesSemanticLightInkInDarkMode() {
        XCTAssertEqualRGB(
            resolvedRGB(surfAceToolbarForeground(), userInterfaceStyle: .dark),
            RGB(red: 1, green: 1, blue: 1)
        )
    }

    private func resolvedRGB(_ color: Color, userInterfaceStyle: UIUserInterfaceStyle) -> RGB {
        let traits = UITraitCollection(userInterfaceStyle: userInterfaceStyle)
        let resolved = UIColor(color).resolvedColor(with: traits)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return RGB(red: red, green: green, blue: blue)
    }

    private struct RGB: Equatable {
        let red: CGFloat
        let green: CGFloat
        let blue: CGFloat
    }

    private func XCTAssertEqualRGB(
        _ actual: RGB,
        _ expected: RGB,
        file: StaticString = #filePath,
        line: UInt = #line
    ) {
        XCTAssertEqual(actual.red, expected.red, accuracy: 0.0001, file: file, line: line)
        XCTAssertEqual(actual.green, expected.green, accuracy: 0.0001, file: file, line: line)
        XCTAssertEqual(actual.blue, expected.blue, accuracy: 0.0001, file: file, line: line)
    }
}
