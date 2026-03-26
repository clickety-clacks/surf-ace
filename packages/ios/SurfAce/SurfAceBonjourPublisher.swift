import Foundation

private func surfAceBonjourLog(_ message: String) {
    print("[SurfAce-Bonjour] \(message)")
}

final class SurfAceBonjourPublisher: NSObject, NetServiceDelegate {
    private var service: NetService?
    var onPublishFailure: (@Sendable (String) -> Void)?

    func publish(name: String, port: Int, txtRecord: [String: String]) {
        surfAceBonjourLog("publish requested name=\(name) port=\(port) txtKeys=\(txtRecord.keys.sorted())")
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
        surfAceBonjourLog("update TXT name=\(service?.name ?? "nil") txtKeys=\(txtRecord.keys.sorted())")
        service?.setTXTRecord(NetService.data(fromTXTRecord: encodeTXTRecord(txtRecord)))
    }

    func stop() {
        surfAceBonjourLog("stop requested name=\(service?.name ?? "nil")")
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
        surfAceBonjourLog("publish failed name=\(sender.name) \(details)")
        let callback = onPublishFailure
        DispatchQueue.main.async {
            callback?(details)
        }
    }

    func netServiceDidPublish(_ sender: NetService) {
        surfAceBonjourLog("publish succeeded name=\(sender.name) type=\(sender.type) domain=\(sender.domain)")
    }

    func netServiceDidStop(_ sender: NetService) {
        surfAceBonjourLog("service stopped name=\(sender.name)")
    }
}
