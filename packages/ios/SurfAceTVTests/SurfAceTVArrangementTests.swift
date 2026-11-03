import XCTest
@testable import SurfAce

final class SurfAceTVArrangementTests: XCTestCase {
    func testResizePreviewDoesNotMutateOriginalAndPreservesPaneIdentity() throws {
        let original = SurfAcePaneLayoutNode.split(direction: .horizontal, children: [.leaf(1), .leaf(2)])
        var preview = SurfAceTVArrangement(original: original, expectedRevision: 7, paneId: 1, targetPaneId: 2)
        preview.action = .resize
        preview.fraction = 0.7
        XCTAssertEqual(preview.preview.paneIDs, [1, 2])
        guard case .split(_, let before, _) = original,
              case .split(_, let after, _) = preview.preview else { return XCTFail("split missing") }
        XCTAssertEqual(before.map(\.layoutWeight), [1, 1])
        XCTAssertEqual(after[0].layoutWeight, 1.4, accuracy: 0.001)
        XCTAssertEqual(after[1].layoutWeight, 0.6, accuracy: 0.001)
    }
    func testMoveRetainsEveryPaneExactlyOnce() {
        let original = SurfAcePaneLayoutNode.split(direction: .horizontal, children: [.leaf(1), .leaf(2), .leaf(3)])
        var preview = SurfAceTVArrangement(original: original, expectedRevision: 2, paneId: 3, targetPaneId: 1)
        preview.action = .move
        preview.before = true
        XCTAssertEqual(preview.preview.paneIDs, [3, 1, 2])
        XCTAssertEqual(original.paneIDs, [1, 2, 3])
    }
    func testSplitUsesOnlyTemporaryPreviewIdentity() {
        let original = SurfAcePaneLayoutNode.leaf(5)
        let preview = SurfAceTVArrangement(original: original, expectedRevision: 0, paneId: 5, targetPaneId: 5)
        XCTAssertEqual(preview.preview.paneIDs, [5, -1])
        XCTAssertEqual(original.paneIDs, [5])
        XCTAssertThrowsError(try canonicalTopologyJSON(from: .init(from: preview.preview)))
    }
}
