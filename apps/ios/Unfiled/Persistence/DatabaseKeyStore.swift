import Foundation
import Security

enum DatabaseKeyStoreError: Error, Equatable {
    case invalidStoredKey
    case randomGenerationFailed(OSStatus)
    case readFailed(OSStatus)
    case writeFailed(OSStatus)
}

protocol DatabaseKeyProviding: Sendable {
    func loadOrCreateKey() throws -> Data
}

struct KeychainDatabaseKeyStore: DatabaseKeyProviding {
    private let account = "local-sqlcipher-key-v1"
    private let keyByteCount = 32
    private let service: String

    init(bundleIdentifier: String) {
        service = "\(bundleIdentifier).database"
    }

    func loadOrCreateKey() throws -> Data {
        switch try readKey() {
        case let .some(key):
            guard key.count == keyByteCount else {
                throw DatabaseKeyStoreError.invalidStoredKey
            }
            return key
        case .none:
            var key = try randomKey()
            defer { key.resetBytes(in: 0 ..< key.count) }
            try store(key)
            guard let storedKey = try readKey(), storedKey.count == keyByteCount else {
                throw DatabaseKeyStoreError.invalidStoredKey
            }
            // Another scene or process may win the first-launch insertion race.
            // The item that actually lives in Keychain is the only key we may use.
            return storedKey
        }
    }

    private func readKey() throws -> Data? {
        var item: CFTypeRef?
        let status = SecItemCopyMatching(
            [
                kSecClass: kSecClassGenericPassword,
                kSecAttrAccount: account,
                kSecAttrService: service,
                kSecAttrSynchronizable: false,
                kSecMatchLimit: kSecMatchLimitOne,
                kSecReturnData: true
            ] as CFDictionary,
            &item
        )
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess else {
            throw DatabaseKeyStoreError.readFailed(status)
        }
        guard let data = item as? Data else {
            throw DatabaseKeyStoreError.invalidStoredKey
        }
        return data
    }

    private func randomKey() throws -> Data {
        var bytes = [UInt8](repeating: 0, count: keyByteCount)
        defer {
            _ = bytes.withUnsafeMutableBytes { buffer in
                buffer.initializeMemory(as: UInt8.self, repeating: 0)
            }
        }
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw DatabaseKeyStoreError.randomGenerationFailed(status)
        }
        return Data(bytes)
    }

    private func store(_ key: Data) throws {
        let attributes: [CFString: Any] = [
            kSecClass: kSecClassGenericPassword,
            kSecAttrAccount: account,
            kSecAttrService: service,
            kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
            kSecAttrSynchronizable: false,
            kSecValueData: key
        ]
        let status = SecItemAdd(attributes as CFDictionary, nil)
        if status == errSecDuplicateItem { return }
        guard status == errSecSuccess else {
            throw DatabaseKeyStoreError.writeFailed(status)
        }
    }
}
