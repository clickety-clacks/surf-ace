import Foundation

/// A value-only preview. No authority mutation occurs until Confirm.
struct SurfAceTVArrangement {
    enum Action: String, CaseIterable { case split, move, resize }
    let original: SurfAcePaneLayoutNode
    let expectedRevision: Int64
    var action: Action = .split
    var paneId: Int
    var targetPaneId: Int
    var direction: SurfAceLayoutDirection = .horizontal
    var before = false
    var fraction: Double = 0.5

    var preview: SurfAcePaneLayoutNode {
        switch action {
        case .split:
            return replacing(paneId, in: original) { leaf in
                .split(direction: direction, children: [leaf, .leaf(-1)])
            }
        case .move:
            guard paneId != targetPaneId, let moving = leaf(paneId, in: original),
                  let remainder = removing(paneId, from: original) else { return original }
            return replacing(targetPaneId, in: remainder) { target in
                .split(direction: direction, children: before ? [moving, target] : [target, moving])
            }
        case .resize:
            return resizing(paneId, in: original)
        }
    }
    var resizeRequest: (path: [Int], weights: [Double], identity: String)? {
        func find(_ node: SurfAcePaneLayoutNode, path: [Int]) -> (path: [Int], weights: [Double], identity: String)? {
            guard case .split(_, let children, _) = node else { return nil }
            if children.contains(where: { if case .leaf(let id, _) = $0 { id == paneId } else { false } }),
               case .split(_, let resized, _) = resizing(paneId, in: node) {
                return (path, resized.map(\.layoutWeight), node.layoutIdentity)
            }
            for (index, child) in children.enumerated() {
                if let result = find(child, path: path + [index]) { return result }
            }
            return nil
        }
        return find(original, path: [])
    }
    private func leaf(_ id: Int, in node: SurfAcePaneLayoutNode) -> SurfAcePaneLayoutNode? {
        switch node {
        case .leaf(let pane, _): return pane == id ? node : nil
        case .split(_, let children, _): return children.compactMap { leaf(id, in: $0) }.first
        case .empty: return nil
        }
    }
    private func replacing(_ id: Int, in node: SurfAcePaneLayoutNode, transform: (SurfAcePaneLayoutNode) -> SurfAcePaneLayoutNode) -> SurfAcePaneLayoutNode {
        switch node {
        case .leaf(let pane, _): return pane == id ? transform(node) : node
        case .split(let direction, let children, let weight):
            return .split(direction: direction, children: children.map { replacing(id, in: $0, transform: transform) }, weight: weight)
        case .empty: return node
        }
    }
    private func removing(_ id: Int, from node: SurfAcePaneLayoutNode) -> SurfAcePaneLayoutNode? {
        switch node {
        case .leaf(let pane, _): return pane == id ? nil : node
        case .split(let direction, let children, let weight):
            let remaining = children.compactMap { removing(id, from: $0) }
            if remaining.count == 1 { return remaining[0] }
            return remaining.isEmpty ? nil : .split(direction: direction, children: remaining, weight: weight)
        case .empty: return nil
        }
    }
    private func resizing(_ id: Int, in node: SurfAcePaneLayoutNode) -> SurfAcePaneLayoutNode {
        guard case .split(let direction, let children, let weight) = node else { return node }
        if let index = children.firstIndex(where: { if case .leaf(let pane, _) = $0 { pane == id } else { false } }), children.count > 1 {
            let adjacent = index == children.count - 1 ? index - 1 : index + 1
            var weights = children.map(\.layoutWeight)
            let total = weights[index] + weights[adjacent]
            weights[index] = total * min(0.9, max(0.1, fraction))
            weights[adjacent] = total - weights[index]
            return node.updatingSplitWeights(path: [], weights: weights)
        }
        return .split(direction: direction, children: children.map { resizing(id, in: $0) }, weight: weight)
    }
}
