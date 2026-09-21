import Foundation

@MainActor
final class SurfAceCentralDiscoveryLifecycle {
    private struct Attempt {
        let generation: UInt64
        var browsing = true
        var pending: Set<ObjectIdentifier> = []
        var completion: CheckedContinuation<Void, Never>?
    }

    private var nextGeneration: UInt64 = 0
    private var attempt: Attempt?

    var pendingCount: Int { attempt?.pending.count ?? 0 }

    func beginBrowsing() -> UInt64 {
        precondition(attempt == nil)
        nextGeneration &+= 1
        attempt = Attempt(generation: nextGeneration)
        return nextGeneration
    }

    func found(_ service: AnyObject, generation: UInt64) -> Bool {
        guard var current = attempt,
              current.generation == generation,
              current.browsing,
              current.pending.insert(ObjectIdentifier(service)).inserted else { return false }
        attempt = current
        return true
    }

    func resolutionSucceeded(_ service: AnyObject, generation: UInt64) -> Bool {
        resolutionEnded(service, generation: generation)
    }

    func resolutionFailed(_ service: AnyObject, generation: UInt64) -> Bool {
        resolutionEnded(service, generation: generation)
    }

    func endBrowsing(generation: UInt64) {
        guard var current = attempt, current.generation == generation else { return }
        // Closing the browse window stops intake; pending resolver callbacks still own completion.
        current.browsing = false
        attempt = current
        completeIfReady(generation: generation)
    }

    func resolutionTimedOut(generation: UInt64) {
        invalidate(generation: generation)
    }

    func cancel(generation: UInt64) {
        invalidate(generation: generation)
    }

    func isComplete(generation: UInt64) -> Bool {
        attempt?.generation != generation
    }

    func waitUntilComplete(generation: UInt64) async {
        guard attempt?.generation == generation else { return }
        await withCheckedContinuation { continuation in
            guard var current = attempt, current.generation == generation else {
                continuation.resume()
                return
            }
            precondition(current.completion == nil)
            current.completion = continuation
            attempt = current
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

    private func resolutionEnded(_ service: AnyObject, generation: UInt64) -> Bool {
        guard var current = attempt,
              current.generation == generation,
              current.pending.remove(ObjectIdentifier(service)) != nil else { return false }
        attempt = current
        completeIfReady(generation: generation)
        return true
    }

    private func completeIfReady(generation: UInt64) {
        guard let current = attempt,
              current.generation == generation,
              !current.browsing,
              current.pending.isEmpty else { return }
        attempt = nil
        current.completion?.resume()
    }

    private func invalidate(generation: UInt64) {
        guard let current = attempt, current.generation == generation else { return }
        attempt = nil
        current.completion?.resume()
    }
}
