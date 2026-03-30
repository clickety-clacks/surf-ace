import XCTest
@testable import SurfAce

final class SurfAceBonjourPublisherTests: XCTestCase {
    func testUpdateTXTRecordRepublishesAfterServiceStops() {
        var services: [FakeNetService] = []
        let publisher = SurfAceBonjourPublisher(
            serviceFactory: { name, port in
                let service = FakeNetService(name: name, port: port)
                services.append(service)
                return service
            },
            permissionPromptTrigger: {}
        )

        publisher.publish(name: "Emanator", port: 19_001, txtRecord: ["busy": "0"])
        XCTAssertEqual(services.count, 1)
        XCTAssertEqual(services[0].publishCallCount, 1)

        publisher.netServiceDidStop(services[0])
        publisher.updateTXTRecord(["busy": "1"])

        XCTAssertEqual(services.count, 2)
        XCTAssertEqual(services[1].publishCallCount, 1)
        XCTAssertEqual(services[1].lastTXTRecord, NetService.data(fromTXTRecord: ["busy": Data("1".utf8)]))
    }

    func testExplicitStopPreventsImplicitRepublishOnTXTUpdate() {
        var services: [FakeNetService] = []
        let publisher = SurfAceBonjourPublisher(
            serviceFactory: { name, port in
                let service = FakeNetService(name: name, port: port)
                services.append(service)
                return service
            },
            permissionPromptTrigger: {}
        )

        publisher.publish(name: "Emanator", port: 19_001, txtRecord: ["busy": "0"])
        publisher.stop()
        publisher.updateTXTRecord(["busy": "1"])

        XCTAssertEqual(services.count, 1)
        XCTAssertEqual(services[0].stopCallCount, 1)
    }
}

private final class FakeNetService: NetService {
    let fakeName: String
    let fakeType: String
    let fakeDomain: String
    private let fakePort: Int32

    var publishCallCount = 0
    var stopCallCount = 0
    var lastTXTRecord: Data?

    init(name: String, port: Int) {
        self.fakeName = name
        self.fakeType = "_surf-ace._tcp."
        self.fakeDomain = "local."
        self.fakePort = Int32(port)
        super.init(domain: fakeDomain, type: fakeType, name: fakeName, port: fakePort)
    }

    override var name: String {
        fakeName
    }

    override var type: String {
        fakeType
    }

    override var domain: String {
        fakeDomain
    }

    override func publish(options: NetService.Options = []) {
        publishCallCount += 1
    }

    override func setTXTRecord(_ recordData: Data?) -> Bool {
        lastTXTRecord = recordData
        return true
    }

    override func stop() {
        stopCallCount += 1
    }
}
