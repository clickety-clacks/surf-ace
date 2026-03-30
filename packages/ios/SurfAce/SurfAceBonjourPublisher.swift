import Foundation
import Network

private func surfAceBonjourLog(_ message: String) {
    print("[SurfAce-Bonjour] \(message)")
}

final class SurfAceBonjourPublisher: NSObject, NetServiceDelegate {
    private struct Publication {
        let name: String
        let port: Int
        let txtRecord: [String: String]
    }

    private var service: NetService?
    private var desiredPublication: Publication?
    private let permissionPromptTrigger: () -> Void
    private let serviceFactory: (String, Int) -> NetService
    var onPublishFailure: (@Sendable (String) -> Void)?

    override init() {
        self.permissionPromptTrigger = {
            SurfAceBonjourPublisher.triggerLocalNetworkPermissionPrompt()
        }
        self.serviceFactory = { name, port in
            NetService(
                domain: "local.",
                type: "_surf-ace._tcp.",
                name: name,
                port: Int32(port)
            )
        }
        super.init()
    }

    init(
        serviceFactory: @escaping (String, Int) -> NetService,
        permissionPromptTrigger: @escaping () -> Void
    ) {
        self.serviceFactory = serviceFactory
        self.permissionPromptTrigger = permissionPromptTrigger
        super.init()
    }

    func publish(name: String, port: Int, txtRecord: [String: String]) {
        surfAceBonjourLog(
            "publish requested name=\(name) port=\(port) txtKeys=\(txtRecord.keys.sorted())"
        )
        desiredPublication = Publication(name: name, port: port, txtRecord: txtRecord)
        publishDesiredPublication(replacingExistingService: true)
    }

    func updateTXTRecord(_ txtRecord: [String: String]) {
        if let publication = desiredPublication {
            desiredPublication = Publication(
                name: publication.name,
                port: publication.port,
                txtRecord: txtRecord
            )
        }
        surfAceBonjourLog("update TXT name=\(service?.name ?? "nil") txtKeys=\(txtRecord.keys.sorted())")
        if service == nil {
            publishDesiredPublication(replacingExistingService: false)
            return
        }
        service?.setTXTRecord(NetService.data(fromTXTRecord: encodeTXTRecord(txtRecord)))
    }

    func stop() {
        desiredPublication = nil
        stopService()
    }

    private func publishDesiredPublication(replacingExistingService: Bool) {
        guard let publication = desiredPublication else { return }
        if replacingExistingService {
            stopService()
        } else if service != nil {
            return
        }

        permissionPromptTrigger()
        let service = serviceFactory(publication.name, publication.port)
        service.delegate = self
        service.setTXTRecord(NetService.data(fromTXTRecord: encodeTXTRecord(publication.txtRecord)))
        service.publish(options: .noAutoRename)
        self.service = service
    }

    private func stopService() {
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
        if service === sender {
            service = nil
        }
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
        if service === sender {
            service = nil
        }
    }

    private static func triggerLocalNetworkPermissionPrompt() {
        surfAceBonjourLog("permission trigger start")
        let parameters = NWParameters()
        parameters.includePeerToPeer = true
        let browser = NWBrowser(
            for: .bonjour(type: "_surf-ace._tcp", domain: nil),
            using: parameters
        )
        browser.stateUpdateHandler = { [browser] state in
            switch state {
            case .setup:
                surfAceBonjourLog("permission trigger setup")
            case .ready:
                surfAceBonjourLog("permission trigger ready")
                browser.stateUpdateHandler = nil
                browser.browseResultsChangedHandler = nil
                browser.cancel()
            case .waiting(let error):
                surfAceBonjourLog("permission trigger waiting error=\(error.localizedDescription)")
            case .failed(let error):
                surfAceBonjourLog("permission trigger failed error=\(error.localizedDescription)")
                browser.stateUpdateHandler = nil
                browser.browseResultsChangedHandler = nil
                browser.cancel()
            case .cancelled:
                surfAceBonjourLog("permission trigger cancelled")
            @unknown default:
                surfAceBonjourLog("permission trigger unknown state")
                browser.stateUpdateHandler = nil
                browser.browseResultsChangedHandler = nil
                browser.cancel()
            }
        }
        browser.browseResultsChangedHandler = { _, _ in }
        browser.start(queue: .main)
        DispatchQueue.main.asyncAfter(deadline: .now() + 5) { [browser] in
            browser.stateUpdateHandler = nil
            browser.browseResultsChangedHandler = nil
            browser.cancel()
        }
    }
}
