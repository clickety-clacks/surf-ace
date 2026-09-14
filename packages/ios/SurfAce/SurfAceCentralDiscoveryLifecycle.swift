import Foundation

@MainActor
final class SurfAceCentralDiscoveryLifecycle {
    private var browsing = false
    private var pending: Set<ObjectIdentifier> = []
    private var completion: CheckedContinuation<Void, Never>?

    var isComplete: Bool { !browsing && pending.isEmpty }
    var pendingCount: Int { pending.count }

    func beginBrowsing() {
        precondition(completion == nil)
        browsing = true
        pending.removeAll()
    }

    func found(_ service: AnyObject) {
        pending.insert(ObjectIdentifier(service))
    }

    func resolutionSucceeded(_ service: AnyObject) {
        resolutionEnded(service)
    }

    func resolutionFailed(_ service: AnyObject) {
        resolutionEnded(service)
    }

    func endBrowsing() {
        // Closing the browse window stops intake; pending resolver callbacks still own completion.
        browsing = false
        completeIfReady()
    }

    func resolutionTimedOut() {
        browsing = false
        pending.removeAll()
        completeIfReady()
    }

    func waitUntilComplete() async {
        if isComplete { return }
        await withCheckedContinuation { continuation in
            precondition(completion == nil)
            completion = continuation
        }
    }

    static func localTransportURL(host: String, port: Int, path: String) -> URL? {
        guard path.hasPrefix("/") else { return nil }
        let normalizedHost = host.hasSuffix(".") ? String(host.dropLast()) : host
        guard !normalizedHost.isEmpty else { return nil }
        var components = URLComponents()
        components.scheme = "ws"
        components.host = normalizedHost
        components.port = port
        components.path = path
        return components.url
    }

    private func resolutionEnded(_ service: AnyObject) {
        pending.remove(ObjectIdentifier(service))
        completeIfReady()
    }

    private func completeIfReady() {
        guard isComplete, let completion else { return }
        self.completion = nil
        completion.resume()
    }
}
