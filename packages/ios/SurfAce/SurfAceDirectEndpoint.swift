import Darwin
import Foundation

struct SurfAceDirectEndpointSelection: Equatable, Sendable {
    let endpoint: String
    let isConfirmed: Bool
    let warnings: [String]

    static func select(
        configuredEndpoint: String?,
        observedAddress: String?,
        listeningPort: Int
    ) -> Self {
        var warnings: [String] = []
        if let configuredEndpoint = configuredEndpoint?.trimmingCharacters(in: .whitespacesAndNewlines),
           !configuredEndpoint.isEmpty {
            if isSupportedEndpoint(configuredEndpoint) {
                return Self(endpoint: configuredEndpoint, isConfirmed: true, warnings: [])
            }
            warnings.append("registration_configured_endpoint_unrecognized")
        }

        let port = (1...65_535).contains(listeningPort) ? listeningPort : 19_001
        if port != listeningPort { warnings.append("registration_listening_port_unrecognized") }
        if let observedAddress, let endpoint = endpoint(address: observedAddress, port: port) {
            warnings.append("registration_direct_endpoint_unconfirmed")
            return Self(endpoint: endpoint, isConfirmed: false, warnings: warnings)
        }

        warnings.append("registration_direct_endpoint_unavailable_using_loopback")
        return Self(
            endpoint: endpoint(address: "127.0.0.1", port: port)!,
            isConfirmed: false,
            warnings: warnings
        )
    }

    static func observedConnectionAddress() -> String? {
        var head: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&head) == 0, let first = head else { return nil }
        defer { freeifaddrs(first) }

        var candidates: [(priority: Int, interface: String, address: String)] = []
        var current: UnsafeMutablePointer<ifaddrs>? = first
        while let entry = current {
            let item = entry.pointee
            current = item.ifa_next
            guard let socketAddress = item.ifa_addr,
                  item.ifa_flags & UInt32(IFF_UP) != 0,
                  item.ifa_flags & UInt32(IFF_LOOPBACK) == 0 else { continue }

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
            guard let address, isUsableObservedAddress(address) else { continue }

            let interface = String(cString: item.ifa_name)
            let priority: Int
            if interface == "en0" {
                priority = family == AF_INET ? 0 : 1
            } else if interface.hasPrefix("pdp_ip") {
                priority = family == AF_INET ? 2 : 3
            } else {
                priority = family == AF_INET ? 4 : 5
            }
            candidates.append((priority, interface, address))
        }
        return candidates.sorted {
            if $0.priority != $1.priority { return $0.priority < $1.priority }
            if $0.interface != $1.interface { return $0.interface < $1.interface }
            return $0.address < $1.address
        }.first?.address
    }

    static func endpoint(address: String, port: Int) -> String? {
        guard (1...65_535).contains(port),
              !address.isEmpty,
              !address.contains("/"),
              !address.contains("@") else { return nil }
        var components = URLComponents()
        components.scheme = "ws"
        components.host = address
        components.port = port
        components.path = "/ws"
        guard let value = components.string, isSupportedEndpoint(value) else { return nil }
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
}
