import Foundation

final class SurfAceBonjourPublisher: NSObject, NetServiceDelegate {
    private var service: NetService?
    var onPublishFailure: (@Sendable (String) -> Void)?

    func publish(name: String, port: Int, txtRecord: [String: String]) {
        stop()
        let service = NetService(
            domain: "local.",
            type: "_surf-ace._tcp.",
            name: name,
            port: Int32(port)
        )
        service.delegate = self
        service.setTXTRecord(NetService.data(fromTXTRecord: encodeTXTRecord(txtRecord)))
        service.publish(options: .noAutoRename)
        self.service = service
    }

    func updateTXTRecord(_ txtRecord: [String: String]) {
        service?.setTXTRecord(NetService.data(fromTXTRecord: encodeTXTRecord(txtRecord)))
    }

    func stop() {
        service?.stop()
        service = nil
    }

    private func encodeTXTRecord(_ values: [String: String]) -> [String: Data] {
        values.reduce(into: [String: Data]()) { partialResult, entry in
            partialResult[entry.key] = entry.value.data(using: .utf8)
        }
    }

    func netService(_ sender: NetService, didNotPublish errorDict: [String: NSNumber]) {
        let errorCode = errorDict[NetService.errorCode]?.intValue ?? -1
        let errorDomain = errorDict[NetService.errorDomain]?.intValue ?? 0
        let details = "domain=\(errorDomain) code=\(errorCode)"
        let callback = onPublishFailure
        DispatchQueue.main.async {
            callback?(details)
        }
    }
}
