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
    case keychain(OSStatus)
    case invalidStoredKey
    case persistenceReadback
}

struct SurfAceIdentityStore {
    private let service = "co.clicketyclacks.SurfAce"
    private let account = "ed25519-private-key"

    func loadOrCreateIdentity() throws -> SurfAceIdentity {
        if let stored = try loadKeyData() {
            let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: stored)
            return makeIdentity(from: privateKey)
        }

        let privateKey = Curve25519.Signing.PrivateKey()
        try saveKeyData(privateKey.rawRepresentation)
        guard let stored = try loadKeyData() else {
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

    private func loadKeyData() throws -> Data? {
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
        guard status == errSecSuccess else { throw SurfAceIdentityStoreError.keychain(status) }
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
            throw SurfAceIdentityStoreError.keychain(status)
        }
    }
}
