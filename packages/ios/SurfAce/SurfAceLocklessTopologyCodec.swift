import Foundation

private func topologyWeight(_ value: SurfAceLocklessJSON?) throws -> SurfAceLocklessJSON? {
    guard let value else { return nil }
    let number: Double
    switch value {
    case .double(let weight): number = weight
    case .integer(let weight): number = Double(weight)
    default: throw SurfAceLocklessAuthorityError.invalidState("topology_weight")
    }
    guard number.isFinite, number > 0 else {
        throw SurfAceLocklessAuthorityError.invalidState("topology_weight")
    }
    return value
}

private func layoutWeight(_ value: SurfAceLocklessJSON?) throws -> Double? {
    guard let value = try topologyWeight(value) else { return nil }
    switch value {
    case .double(let weight): return weight
    case .integer(let weight): return Double(weight)
    default: return nil
    }
}

#if canImport(UIKit)
func canonicalTopologyJSON(
    from layout: SurfAcePersistedPaneLayoutNode
) throws -> SurfAceLocklessJSON {
    switch layout {
    case .empty:
        throw SurfAceLocklessAuthorityError.invalidState("topology_empty")
    case .leaf(let paneId, let weight):
        guard paneId > 0 else { throw SurfAceLocklessAuthorityError.invalidState("topology_pane_id") }
        var object: [String: SurfAceLocklessJSON] = [
            "paneId": .integer(Int64(paneId)), "type": .string("pane"),
        ]
        if let weight { object["weight"] = try topologyWeight(.double(weight)) }
        return .object(object)
    case .split(let direction, let children, let weight):
        guard children.count >= 2 else {
            throw SurfAceLocklessAuthorityError.invalidState("topology_split_children")
        }
        var object: [String: SurfAceLocklessJSON] = [
            "children": .array(try children.map(canonicalTopologyJSON)),
            "direction": .string(direction.rawValue),
            "type": .string("split"),
        ]
        if let weight { object["weight"] = try topologyWeight(.double(weight)) }
        return .object(object)
    }
}

func persistedPaneLayout(
    fromCanonical json: SurfAceLocklessJSON
) throws -> SurfAcePersistedPaneLayoutNode {
    guard case .object(let object) = json else {
        throw SurfAceLocklessAuthorityError.invalidState("topology_root")
    }
    if case .string("pane") = object["type"],
       Set(object.keys).subtracting(["weight"]) == Set(["paneId", "type"]),
       case .integer(let paneId) = object["paneId"], paneId > 0,
       let nativePaneId = Int(exactly: paneId) {
        return .leaf(nativePaneId, weight: try layoutWeight(object["weight"]))
    }
    guard case .string("split") = object["type"],
          Set(object.keys).subtracting(["weight"]) == Set(["children", "direction", "type"]),
          case .string(let directionValue) = object["direction"],
          let direction = SurfAceLayoutDirection(rawValue: directionValue),
          case .array(let children) = object["children"], children.count >= 2 else {
        throw SurfAceLocklessAuthorityError.invalidState("topology_shape")
    }
    return .split(
        direction: direction,
        children: try children.map { try persistedPaneLayout(fromCanonical: $0) },
        weight: try layoutWeight(object["weight"])
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
            var normalized: [String: SurfAceLocklessJSON] = [
                "paneId": .integer(paneId), "type": .string("pane"),
            ]
            normalized["weight"] = try topologyWeight(object["weight"])
            return .object(normalized)
        }
        if case .string("split") = object["type"],
           case .string(let direction) = object["direction"],
           ["horizontal", "vertical"].contains(direction),
           case .array(let children) = object["children"], children.count >= 2 {
            var normalized: [String: SurfAceLocklessJSON] = [
                "children": .array(try children.map(canonical)),
                "direction": .string(direction),
                "type": .string("split"),
            ]
            normalized["weight"] = try topologyWeight(object["weight"])
            return .object(normalized)
        }
        if case .string("leaf") = object["kind"],
           case .integer(let paneId) = object["paneId"], paneId > 0 {
            var normalized: [String: SurfAceLocklessJSON] = [
                "paneId": .integer(paneId), "type": .string("pane"),
            ]
            normalized["weight"] = try topologyWeight(object["weight"])
            return .object(normalized)
        }
        if case .string("split") = object["kind"],
           case .string(let direction) = object["direction"],
           ["horizontal", "vertical"].contains(direction),
           case .array(let children) = object["children"], children.count >= 2 {
            var normalized: [String: SurfAceLocklessJSON] = [
                "children": .array(try children.map(canonical)),
                "direction": .string(direction),
                "type": .string("split"),
            ]
            normalized["weight"] = try topologyWeight(object["weight"])
            return .object(normalized)
        }
        throw SurfAceLocklessAuthorityError.invalidState("topology_shape")
    }

    static func persistedProjection(_ value: SurfAceLocklessJSON) throws -> SurfAceLocklessJSON {
        let canonical = try canonical(value)
        guard case .object(let object) = canonical else {
            throw SurfAceLocklessAuthorityError.invalidState("topology_root")
        }
        if case .string("pane") = object["type"], let paneId = object["paneId"] {
            var projection: [String: SurfAceLocklessJSON] = [
                "kind": .string("leaf"), "paneId": paneId,
            ]
            projection["weight"] = object["weight"]
            return .object(projection)
        }
        guard case .string("split") = object["type"],
              let direction = object["direction"],
              case .array(let children) = object["children"] else {
            throw SurfAceLocklessAuthorityError.invalidState("topology_shape")
        }
        var projection: [String: SurfAceLocklessJSON] = [
            "children": .array(try children.map(persistedProjection)),
            "direction": direction,
            "kind": .string("split"),
        ]
        projection["weight"] = object["weight"]
        return .object(projection)
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
