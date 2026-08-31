import Foundation
import Security

public final class SystemKeychainStore: SecureDataStore, @unchecked Sendable {
    public init() {}

    public func read(service: String, account: String) throws -> Data? {
        var query = baseQuery(service: service, account: account)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var value: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &value)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = value as? Data else { throw SessionVaultError.unavailable }
        return data
    }

    public func write(_ data: Data, service: String, account: String,
                      accessibility: KeychainAccessibility) throws {
        let query = baseQuery(service: service, account: account)
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: securityAccessibility(accessibility)
        ]
        let update = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw SessionVaultError.unavailable }

        var addition = query
        attributes.forEach { addition[$0.key] = $0.value }
        addition[kSecAttrSynchronizable as String] = false
        let add = SecItemAdd(addition as CFDictionary, nil)
        if add == errSecDuplicateItem {
            guard SecItemUpdate(query as CFDictionary, attributes as CFDictionary) == errSecSuccess else {
                throw SessionVaultError.unavailable
            }
        } else if add != errSecSuccess {
            throw SessionVaultError.unavailable
        }
    }

    public func delete(service: String, account: String) throws {
        let status = SecItemDelete(baseQuery(service: service, account: account) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw SessionVaultError.unavailable }
    }

    private func baseQuery(service: String, account: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrSynchronizable as String: false
        ]
    }

    private func securityAccessibility(_ value: KeychainAccessibility) -> CFString {
        switch value { case .whenUnlockedThisDeviceOnly: kSecAttrAccessibleWhenUnlockedThisDeviceOnly }
    }
}
