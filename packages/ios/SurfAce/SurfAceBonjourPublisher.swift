import Foundation
import Network

private func surfAceBonjourDiagnosticValue(_ value: CustomStringConvertible) -> String {
    let text = String(describing: value)
    return text.range(of: #"^[A-Za-z0-9_./:@%-]+$"#, options: .regularExpression) != nil
        ? text
        : "\"\(text.replacingOccurrences(of: "\"", with: "\\\""))\""
}

private func surfAceBonjourDiagnosticFields(_ fields: [(String, CustomStringConvertible?)]) -> String {
    fields.compactMap { key, value in
        guard let value else { return nil }
        let text = String(describing: value)
        guard !text.isEmpty else { return nil }
        return "\(key)=\(surfAceBonjourDiagnosticValue(value))"
    }.joined(separator: " ")
}

private func surfAceBonjourDiagnostic(_ event: String, _ fields: [(String, CustomStringConvertible?)] = []) -> String {
    let suffix = surfAceBonjourDiagnosticFields(fields)
    return suffix.isEmpty
        ? "event=\(event)"
        : "event=\(event) \(suffix)"
}

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
            surfAceBonjourDiagnostic(
                "publish_attempt",
                [("name", name), ("port", port), ("txt_keys", txtRecord.keys.sorted().joined(separator: ","))]
            )
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
        surfAceBonjourLog(
            surfAceBonjourDiagnostic(
                "publish_txt_update",
                [("name", service?.name ?? "nil"), ("txt_keys", txtRecord.keys.sorted().joined(separator: ","))]
            )
        )
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
        surfAceBonjourLog(
            surfAceBonjourDiagnostic(
                "publish_stop",
                [("name", service?.name ?? "nil")]
            )
        )
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
        surfAceBonjourLog(
            surfAceBonjourDiagnostic(
                "publish_failed",
                [("domain", errorDomain), ("error_code", errorCode), ("name", sender.name)]
            )
        )
        if service === sender {
            service = nil
        }
        let callback = onPublishFailure
        DispatchQueue.main.async {
            callback?(details)
        }
    }

    func netServiceDidPublish(_ sender: NetService) {
        surfAceBonjourLog(
            surfAceBonjourDiagnostic(
                "publish_ok",
                [("domain", sender.domain), ("name", sender.name), ("type", sender.type)]
            )
        )
    }

    func netServiceDidStop(_ sender: NetService) {
        surfAceBonjourLog(
            surfAceBonjourDiagnostic(
                "publish_stopped",
                [("name", sender.name)]
            )
        )
        if service === sender {
            service = nil
        }
    }

    private static func triggerLocalNetworkPermissionPrompt() {
        surfAceBonjourLog(surfAceBonjourDiagnostic("permission_probe_start"))
        let parameters = NWParameters()
        parameters.includePeerToPeer = true
        let browser = NWBrowser(
            for: .bonjour(type: "_surf-ace._tcp", domain: nil),
            using: parameters
        )
        browser.stateUpdateHandler = { [browser] state in
            switch state {
            case .setup:
                surfAceBonjourLog(surfAceBonjourDiagnostic("permission_probe_setup"))
            case .ready:
                surfAceBonjourLog(surfAceBonjourDiagnostic("permission_probe_ready"))
                browser.stateUpdateHandler = nil
                browser.browseResultsChangedHandler = nil
                browser.cancel()
            case .waiting(let error):
                surfAceBonjourLog(
                    surfAceBonjourDiagnostic(
                        "permission_probe_waiting",
                        [("error", error.localizedDescription)]
                    )
                )
            case .failed(let error):
                surfAceBonjourLog(
                    surfAceBonjourDiagnostic(
                        "permission_probe_failed",
                        [("error", error.localizedDescription)]
                    )
                )
                browser.stateUpdateHandler = nil
                browser.browseResultsChangedHandler = nil
                browser.cancel()
            case .cancelled:
                surfAceBonjourLog(surfAceBonjourDiagnostic("permission_probe_cancelled"))
            @unknown default:
                surfAceBonjourLog(surfAceBonjourDiagnostic("permission_probe_unknown"))
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
