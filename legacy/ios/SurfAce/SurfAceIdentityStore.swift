import CryptoKit
import Foundation
import Security

struct SurfAceIdentity {
    let privateKey: Curve25519.Signing.PrivateKey
    let publicKeyRaw: Data
    let fingerprint: String
}

struct SurfAceIdentityStore {
    private let service = "co.clicketyclacks.SurfAce"
    private let account = "ed25519-private-key"

    func loadOrCreateIdentity() throws -> SurfAceIdentity {
        if let stored = loadKeyData() {
            let privateKey = try Curve25519.Signing.PrivateKey(rawRepresentation: stored)
            return makeIdentity(from: privateKey)
        }

        let privateKey = Curve25519.Signing.PrivateKey()
        saveKeyData(privateKey.rawRepresentation)
        return makeIdentity(from: privateKey)
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

    private func loadKeyData() -> Data? {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account,
            kSecReturnData: true,
            kSecMatchLimit: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess else {
            return nil
        }
        return item as? Data
    }

    private func saveKeyData(_ data: Data) {
        let query: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrService: service,
            kSecAttrAccount: account
        ]

        let attributes: [CFString: Any] = [
            kSecValueData: data
        ]

        if SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecSuccess {
            return
        }

        var add = query
        add[kSecValueData] = data
        SecItemAdd(add as CFDictionary, nil)
    }
}
