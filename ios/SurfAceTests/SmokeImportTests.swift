import Testing
@testable import Surf_Ace

@Suite(.serialized)
struct SmokeImportTests {
    @Test("Surf Ace module imports")
    @MainActor
    func importsModule() {
        let runtime = SurfAceRuntime()
        #expect(runtime.screenName.isEmpty == false)
    }

    @Test("Bonjour instance name includes fingerprint suffix and stays bounded")
    @MainActor
    func bonjourInstanceNameIsUniquePerIdentity() {
        let runtime = SurfAceRuntime()
        runtime.screenName = "Surf Ace - iPad"
        runtime.fingerprint = "a1b2c3d4"
        runtime.instanceDisambiguator = "112233"

        let instanceName = runtime.bonjourServiceInstanceName()
        #expect(instanceName.contains("a1b2c3d4-112233"))
        #expect(instanceName.count <= 63)
        #expect(instanceName != runtime.screenName)
    }
}
