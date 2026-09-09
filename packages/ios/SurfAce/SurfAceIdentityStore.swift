import CryptoKit
import Foundation
import Security

struct SurfAceIdentity {
    let privateKey: Curve25519.Signing.PrivateKey
    let publicKeyRaw: Data
    let fingerprint: String

    // Match the Electron registration identity: SHA-256 of Ed25519 SPKI DER.
    var clientId: String {
        let spkiPrefix = Data([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00])
        return SHA256.hash(data: spkiPrefix + publicKeyRaw)
            .map { String(format: "%02x", $0) }.joined()
    }
}

enum SurfAceIdentityStoreError: Error {
    case keychain(operation: String, status: OSStatus)
    case invalidStoredKey
    case persistenceReadback
}

struct SurfAceIdentityStore {
    static func diagnosticOnly(environment: [String: String]) -> Bool {
        environment["SURF_ACE_IDENTITY_DIAGNOSTIC_ONLY"] == "1"
    }

    static func terminalDiagnostic(error: Error?) -> String {
        let result = error.map { "result=failure \(failureDiagnostic($0))" } ?? "result=success"
        return "event=identity_diagnostic_terminal \(result) networking=disabled\n"
    }

    // Emit only a fixed operation name and numeric Security status, never query or key data.
    static func failureDiagnostic(_ error: Error) -> String {
        switch error {
        case SurfAceIdentityStoreError.keychain(let operation, let status):
            let allowed = ["SecItemCopyMatching.initial", "SecItemCopyMatching.readback", "SecItemAdd.create"]
            let safeOperation = allowed.contains(operation) ? operation : "unknown"
            return "operation=\(safeOperation) os_status=\(status)"
        case SurfAceIdentityStoreError.invalidStoredKey:
            return "operation=decode_stored_key result=invalid_data"
        case SurfAceIdentityStoreError.persistenceReadback:
            return "operation=SecItemCopyMatching.readback result=item_missing"
        default:
            return "operation=identity_initialization result=non_security_error"
        }
    }

    private let service = "co.clicketyclacks.SurfAce"
    private let account = "ed25519-private-key"

    func loadOrCreateIdentity() throws -> SurfAceIdentity {
        if let stored = try loadKeyData() {
            let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: stored)
            return makeIdentity(from: privateKey)
        }

        let privateKey = Curve25519.Signing.PrivateKey()
        try saveKeyData(privateKey.rawRepresentation)
        guard let stored = try loadKeyData(operation: "SecItemCopyMatching.readback") else {
            throw SurfAceIdentityStoreError.persistenceReadback
        }
        return makeIdentity(from: try Curve25519.Signing.PrivateKey(rawRepresentation: stored))
    }

    private func makeIdentity(from privateKey: Curve25519.Signing.PrivateKey) -> SurfAceIdentity {
        let publicKeyRaw = privateKey.publicKey.rawRepresentation
        let hash = SHA256.hash(data: publicKeyRaw)
        let fingerprint = hash.compactMap { String(format: "%02x", $0) }.joined().prefix(8)
        return SurfAceIdentity(
            privateKey: privateKey,
            publicKeyRaw: publicKeyRaw,
            fingerprint: String(fingerprint)
        )
    }

    private func loadKeyData(operation: String = "SecItemCopyMatching.initial") throws -> Data? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else { throw SurfAceIdentityStoreError.keychain(operation: operation, status: status) }
        guard let data = item as? Data else { throw SurfAceIdentityStoreError.invalidStoredKey }
        return data
    }

    private func saveKeyData(_ data: Data) throws {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecValueData: data
        ]
        // Never overwrite an identity created by another concurrent startup.
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess || status == errSecDuplicateItem else {
            throw SurfAceIdentityStoreError.keychain(operation: "SecItemAdd.create", status: status)
        }
    }
}

// The app entry point uses this before constructing any runtime or network component.
enum SurfAceIdentityDiagnosticStartup {
    static func makeRuntime<T>(enabled: Bool, diagnostic: () -> Void, runtime: () -> T) -> T? {
        if enabled { diagnostic(); return nil }
        return runtime()
    }

    static func capture(to url: URL, loadIdentity: () throws -> Void) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data().write(to: url, options: .atomic)
        let file = try FileHandle(forWritingTo: url)
        defer { try? file.close() }
        try file.write(contentsOf: Data("event=identity_diagnostic_begin networking=disabled\n".utf8))
        try file.synchronize()
        var failure: Error?
        do { try loadIdentity() } catch { failure = error }
        let terminal = SurfAceIdentityStore.terminalDiagnostic(error: failure)
        try file.write(contentsOf: Data(terminal.utf8))
        try file.synchronize()
        FileHandle.standardError.write(Data(terminal.utf8))
    }
}
