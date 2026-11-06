import Darwin
import Foundation

enum SurfAceDirectEndpointSource: String, Codable, Equatable, Sendable {
    case configured
    case clientReported = "client-reported"
    case registryObserved = "registry-observed"
}

// The client request type excludes registry-observed so only a registry can assert it.
enum SurfAceRegistrationEndpointSource: String, Codable, Equatable, Sendable {
    case configured
    case clientReported = "client-reported"
}

struct SurfAceDirectEndpointListener: Codable, Equatable, Sendable {
    let scheme: String
    let port: Int
    let path: String
}

struct SurfAceDirectEndpointSelection: Equatable, Sendable {
    struct InterfaceAddressCandidate: Equatable, Sendable {
        let interface: String
        let address: String
    }

    enum ObservedAddressResult: Equatable, Sendable {
        case selected(String)
        case noCellularInterface
        case inventoryUnavailable
        case cellularOnly
    }

    let endpoint: String?
    let source: SurfAceRegistrationEndpointSource?
    let listener: SurfAceDirectEndpointListener?
    let warnings: [String]

    static func select(
        configuredEndpoint: String?,
        observedAddress: ObservedAddressResult,
        listeningPort: Int,
        allowLoopbackObservedAddress: Bool = false
    ) -> Self {
        var warnings: [String] = []
        let listener: SurfAceDirectEndpointListener?
        if (1...65_535).contains(listeningPort) {
            listener = SurfAceDirectEndpointListener(scheme: "ws", port: listeningPort, path: "/ws")
        } else {
            listener = nil
            warnings.append("registration_listening_port_unrecognized")
        }

        if let configuredEndpoint = configuredEndpoint?.trimmingCharacters(in: .whitespacesAndNewlines),
           !configuredEndpoint.isEmpty {
            if isSupportedEndpoint(configuredEndpoint) {
                return Self(endpoint: configuredEndpoint, source: .configured, listener: nil, warnings: [])
            }
            warnings.append("registration_configured_endpoint_unrecognized")
        }

        if case .selected(let address) = observedAddress,
           (isUsableObservedAddress(address)
                || (allowLoopbackObservedAddress && isLoopbackAddress(address))),
           let listener,
           let endpoint = endpoint(address: address, port: listener.port) {
            warnings.append("registration_direct_endpoint_unconfirmed source=client-reported")
            return Self(endpoint: endpoint, source: .clientReported, listener: listener, warnings: warnings)
        }

        switch observedAddress {
        case .noCellularInterface:
            if let listener {
                warnings.append("registration_direct_endpoint_unconfirmed source=registry-observed")
                return Self(endpoint: nil, source: nil, listener: listener, warnings: warnings)
            }
            warnings.append("registration_direct_endpoint_unavailable")
        case .inventoryUnavailable:
            warnings.append("registration_direct_endpoint_interface_inventory_unavailable")
        case .cellularOnly:
            warnings.append("registration_direct_endpoint_cellular_only")
        case .selected:
            warnings.append("registration_direct_endpoint_unavailable")
        }

        return Self(
            endpoint: nil,
            source: nil,
            listener: nil,
            warnings: warnings
        )
    }

    static func observedConnectionAddress() -> ObservedAddressResult {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return .inventoryUnavailable }
        defer { freeifaddrs(first) }

        var candidates: [InterfaceAddressCandidate] = []
        var cellularInterfacePresent = false
        var current: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = current {
            let item = entry.pointee
            current = item.ifa_next
            let interface = String(cString: item.ifa_name)
            let properties = interfaceProperties(interface: interface, flags: item.ifa_flags)
            if properties.isCellular { cellularInterfacePresent = true }
            guard properties.canProvideAddress else { continue }
            guard let socketAddress = item.ifa_addr else { continue }

            let family = Int32(socketAddress.pointee.sa_family)
            let address: String?
            if family == AF_INET {
                let value = UnsafeRawPointer(socketAddress).assumingMemoryBound(to: sockaddr_in.self).pointee
                var numericAddress = value.sin_addr
                var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                address = inet_ntop(AF_INET, &numericAddress, &buffer, socklen_t(buffer.count))
                    .map { _ in String(cString: buffer) }
            } else if family == AF_INET6 {
                let value = UnsafeRawPointer(socketAddress).assumingMemoryBound(to: sockaddr_in6.self).pointee
                var numericAddress = value.sin6_addr
                var buffer = [CChar](repeating: 0, count: Int(INET6_ADDRSTRLEN))
                address = inet_ntop(AF_INET6, &numericAddress, &buffer, socklen_t(buffer.count))
                    .map { _ in String(cString: buffer) }
            } else {
                address = nil
            }
            guard let address else { continue }
            candidates.append(InterfaceAddressCandidate(interface: interface, address: address))
        }
        return preferredObservedAddress(
            candidates: candidates,
            cellularInterfacePresent: cellularInterfacePresent
        )
    }

    static func preferredObservedAddress(
        candidates: [InterfaceAddressCandidate],
        cellularInterfacePresent: Bool
    ) -> ObservedAddressResult {
        let ranked = candidates.compactMap { candidate -> (priority: Int, interface: String, address: String)? in
            guard !isCellularInterface(candidate.interface),
                  isUsableObservedAddress(candidate.address) else { return nil }

            let familyPriority = candidate.address.contains(":") ? 1 : 0
            let interfacePriority: Int
            if candidate.interface.hasPrefix("utun"), isTailnetAddress(candidate.address) {
                interfacePriority = 0
            } else if candidate.interface == "en0" {
                interfacePriority = 2
            } else {
                interfacePriority = 4
            }
            return (
                priority: interfacePriority + familyPriority,
                interface: candidate.interface,
                address: candidate.address
            )
        }
        let selected = ranked.sorted {
            if $0.priority != $1.priority { return $0.priority < $1.priority }
            if $0.interface != $1.interface { return $0.interface < $1.interface }
            return $0.address < $1.address
        }.first?.address

        if let selected { return .selected(selected) }
        return cellularInterfacePresent ? .cellularOnly : .noCellularInterface
    }

    struct InterfaceProperties: Equatable, Sendable {
        let isCellular: Bool
        let canProvideAddress: Bool
    }

    static func interfaceProperties(interface: String, flags: UInt32) -> InterfaceProperties {
        InterfaceProperties(
            isCellular: isCellularInterface(interface),
            canProvideAddress: flags & UInt32(IFF_UP) != 0 && flags & UInt32(IFF_LOOPBACK) == 0
        )
    }

    static func endpoint(address: String, port: Int) -> String? {
        guard (1...65_535).contains(port),
              !address.isEmpty,
              !address.contains("/"),
              !address.contains("@") else { return nil }
        let host = address.contains(":") ? "[\(address)]" : address
        let value = "ws://\(host):\(port)/ws"
        guard isSupportedEndpoint(value) else { return nil }
        return value
    }

    static func isSupportedEndpoint(_ value: String) -> Bool {
        guard value.utf8.count <= 2_048,
              let components = URLComponents(string: value),
              let scheme = components.scheme?.lowercased(),
              scheme == "ws" || scheme == "wss",
              let host = components.host, !host.isEmpty,
              components.user == nil, components.password == nil,
              components.fragment == nil else { return false }
        return true
    }

    private static func isUsableObservedAddress(_ value: String) -> Bool {
        if value.contains(":") {
            let address = value.lowercased()
            return address != "::" && address != "::1"
                && !address.hasPrefix("fe80:") && !address.hasPrefix("ff")
        }
        let octets = value.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        return octets[0] != 0 && octets[0] != 127 && octets[0] < 224
            && !(octets[0] == 169 && octets[1] == 254)
    }

    private static func isLoopbackAddress(_ value: String) -> Bool {
        if value.contains(":"), value.lowercased() == "::1" { return true }
        return value.split(separator: ".").first == "127"
    }

    private static func isCellularInterface(_ interface: String) -> Bool {
        interface.hasPrefix("pdp_ip")
    }

    private static func isTailnetAddress(_ value: String) -> Bool {
        if value.contains(":") {
            guard let firstHextet = value.lowercased().split(separator: ":").first,
                  let prefix = UInt16(firstHextet, radix: 16) else { return false }
            return (prefix & 0xfe00) == 0xfc00
        }

        let octets = value.split(separator: ".").compactMap { Int($0) }
        guard octets.count == 4 else { return false }
        return octets[0] == 100 && (64...127).contains(octets[1])
    }
}
