import Foundation

public enum SessionVaultError: Error, Equatable, Sendable {
    case unavailable
    case corruptData
    case dataTooLarge
}

public protocol SessionVault: Sendable {
    func load() throws -> AuthSession?
    func save(_ session: AuthSession) throws
    func clear() throws
}

public enum KeychainAccessibility: Sendable {
    case whenUnlockedThisDeviceOnly
}

public protocol SecureDataStore: Sendable {
    func read(service: String, account: String) throws -> Data?
    func write(_ data: Data, service: String, account: String,
               accessibility: KeychainAccessibility) throws
    func delete(service: String, account: String) throws
}

struct ExplicitSignOutBarrier {
    static let defaultKey = "unfiled.auth.explicit-sign-out.v1"

    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults = .standard, key: String = defaultKey) {
        self.defaults = defaults
        self.key = key
    }

    var isActive: Bool { defaults.bool(forKey: key) }

    @discardableResult
    func activate() -> Bool {
        defaults.set(true, forKey: key)
        return defaults.synchronize() && isActive
    }

    @discardableResult
    func clear() -> Bool {
        defaults.removeObject(forKey: key)
        return defaults.synchronize() && !isActive
    }
}

public final class KeychainSessionVault: SessionVault, @unchecked Sendable {
    public static let maximumSessionBytes = 32 * 1_024
    private let store: any SecureDataStore
    private let service: String
    private let account: String

    public init(store: any SecureDataStore = SystemKeychainStore(),
                service: String = "app.unfiled.ios.auth", account: String = "session-v1") {
        self.store = store; self.service = service; self.account = account
    }

    public func load() throws -> AuthSession? {
        let data: Data?
        do { data = try store.read(service: service, account: account) }
        catch { throw SessionVaultError.unavailable }
        guard let data else { return nil }
        guard data.count <= Self.maximumSessionBytes else { throw SessionVaultError.corruptData }
        do { return try APIJSON.makeDecoder().decode(AuthSession.self, from: data) }
        catch { throw SessionVaultError.corruptData }
    }

    public func save(_ session: AuthSession) throws {
        guard session.isStructurallyValid else { throw SessionVaultError.corruptData }
        let data: Data
        do { data = try APIJSON.makeEncoder().encode(session) }
        catch { throw SessionVaultError.corruptData }
        guard data.count <= Self.maximumSessionBytes else { throw SessionVaultError.dataTooLarge }
        do {
            try store.write(data, service: service, account: account,
                            accessibility: .whenUnlockedThisDeviceOnly)
        } catch { throw SessionVaultError.unavailable }
    }

    public func clear() throws {
        do { try store.delete(service: service, account: account) }
        catch { throw SessionVaultError.unavailable }
    }
}
