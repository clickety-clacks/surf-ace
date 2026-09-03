import Foundation

#if canImport(UIKit)
func canonicalTopologyJSON(
    from layout: SurfAcePersistedPaneLayoutNode
) throws -> SurfAceLocklessJSON {
    switch layout {
    case .empty:
        throw SurfAceLocklessAuthorityError.invalidState("topology_empty")
    case .leaf(let paneId, _):
        guard paneId > 0 else { throw SurfAceLocklessAuthorityError.invalidState("topology_pane_id") }
        return .object(["paneId": .integer(Int64(paneId)), "type": .string("pane")])
    case .split(let direction, let children, _):
        guard children.count >= 2 else {
            throw SurfAceLocklessAuthorityError.invalidState("topology_split_children")
        }
        return .object([
            "children": .array(try children.map(canonicalTopologyJSON)),
            "direction": .string(direction.rawValue),
            "type": .string("split"),
        ])
    }
}

func persistedPaneLayout(
    fromCanonical json: SurfAceLocklessJSON
) throws -> SurfAcePersistedPaneLayoutNode {
    guard case .object(let object) = json else {
        throw SurfAceLocklessAuthorityError.invalidState("topology_root")
    }
    if case .string("pane") = object["type"],
       Set(object.keys) == Set(["paneId", "type"]),
       case .integer(let paneId) = object["paneId"], paneId > 0,
       let nativePaneId = Int(exactly: paneId) {
        return .leaf(nativePaneId)
    }
    guard case .string("split") = object["type"],
          Set(object.keys) == Set(["children", "direction", "type"]),
          case .string(let directionValue) = object["direction"],
          let direction = SurfAceLayoutDirection(rawValue: directionValue),
          case .array(let children) = object["children"], children.count >= 2 else {
        throw SurfAceLocklessAuthorityError.invalidState("topology_shape")
    }
    return .split(
        direction: direction,
        children: try children.map { try persistedPaneLayout(fromCanonical: $0) }
    )
}
#endif

enum SurfAceLocklessTopologyCodec {
    static func canonical(_ value: SurfAceLocklessJSON) throws -> SurfAceLocklessJSON {
        guard case .object(let object) = value else {
            throw SurfAceLocklessAuthorityError.invalidState("topology_root")
        }
        if case .string("pane") = object["type"],
           case .integer(let paneId) = object["paneId"], paneId > 0 {
            return .object(["paneId": .integer(paneId), "type": .string("pane")])
        }
        if case .string("split") = object["type"],
           case .string(let direction) = object["direction"],
           ["horizontal", "vertical"].contains(direction),
           case .array(let children) = object["children"], children.count >= 2 {
            return .object([
                "children": .array(try children.map(canonical)),
                "direction": .string(direction),
                "type": .string("split"),
            ])
        }
        if case .string("leaf") = object["kind"],
           case .integer(let paneId) = object["paneId"], paneId > 0 {
            return .object(["paneId": .integer(paneId), "type": .string("pane")])
        }
        if case .string("split") = object["kind"],
           case .string(let direction) = object["direction"],
           ["horizontal", "vertical"].contains(direction),
           case .array(let children) = object["children"], children.count >= 2 {
            return .object([
                "children": .array(try children.map(canonical)),
                "direction": .string(direction),
                "type": .string("split"),
            ])
        }
        throw SurfAceLocklessAuthorityError.invalidState("topology_shape")
    }

    static func persistedProjection(_ value: SurfAceLocklessJSON) throws -> SurfAceLocklessJSON {
        let canonical = try canonical(value)
        guard case .object(let object) = canonical else {
            throw SurfAceLocklessAuthorityError.invalidState("topology_root")
        }
        if case .string("pane") = object["type"], let paneId = object["paneId"] {
            return .object(["kind": .string("leaf"), "paneId": paneId])
        }
        guard case .string("split") = object["type"],
              let direction = object["direction"],
              case .array(let children) = object["children"] else {
            throw SurfAceLocklessAuthorityError.invalidState("topology_shape")
        }
        return .object([
            "children": .array(try children.map(persistedProjection)),
            "direction": direction,
            "kind": .string("split"),
        ])
    }

    static func paneIds(_ value: SurfAceLocklessJSON) throws -> [Int64] {
        let canonical = try canonical(value)
        guard case .object(let object) = canonical else { return [] }
        if case .string("pane") = object["type"], case .integer(let paneId) = object["paneId"] {
            return [paneId]
        }
        guard case .array(let children) = object["children"] else { return [] }
        return try children.flatMap(paneIds)
    }
}
