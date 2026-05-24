import SwiftUI
import XCTest
@testable import SurfAce

final class SurfAceToolbarThemeTests: XCTestCase {
    func testToolbarForegroundUsesLightThemeContrast() {
        XCTAssertTrue(surfAceToolbarForegroundColor(for: .light).surfAceIsDarkForTesting)
    }

    func testToolbarForegroundUsesDarkThemeContrast() {
        XCTAssertTrue(surfAceToolbarForegroundColor(for: .dark).surfAceIsLightForTesting)
    }
}

private extension Color {
    var surfAceIsDarkForTesting: Bool {
        surfAceRelativeLuminanceForTesting < 0.5
    }

    var surfAceIsLightForTesting: Bool {
        surfAceRelativeLuminanceForTesting > 0.5
    }

    var surfAceRelativeLuminanceForTesting: CGFloat {
        let uiColor = UIColor(self)
        var red: CGFloat = 0
        var green: CGFloat = 0
        var blue: CGFloat = 0
        var alpha: CGFloat = 0
        uiColor.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
        return 0.2126 * red + 0.7152 * green + 0.0722 * blue
    }
}
