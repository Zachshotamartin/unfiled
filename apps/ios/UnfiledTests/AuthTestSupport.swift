import Foundation
@testable import Unfiled

final class AuthMemorySecureDataStore: SecureDataStore, @unchecked Sendable {
    private let lock = NSLock()
    private var data: Data?
    private(set) var lastAccessibility: KeychainAccessibility?
    var readError = false; var writeError = false; var deleteError = false

    func read(service _: String, account _: String) throws -> Data? {
        try lock.withLock { if readError { throw SessionVaultError.unavailable }; return data }
    }
    func write(_ data: Data, service _: String, account _: String,
               accessibility: KeychainAccessibility) throws {
        try lock.withLock {
            if writeError { throw SessionVaultError.unavailable }
            self.data = data; lastAccessibility = accessibility
        }
    }
    func delete(service _: String, account _: String) throws {
        try lock.withLock { if deleteError { throw SessionVaultError.unavailable }; data = nil }
    }
    func seed(_ value: Data?) { lock.withLock { data = value } }
    func storedData() -> Data? { lock.withLock { data } }
}

final class AuthMemorySessionVault: SessionVault, @unchecked Sendable {
    private let lock = NSLock()
    private var value: AuthSession?
    var failLoad = false; var failSave = false; var failClear = false
    private(set) var saveCount = 0; private(set) var clearCount = 0
    init(_ value: AuthSession? = nil) { self.value = value }
    func load() throws -> AuthSession? { try lock.withLock { if failLoad { throw SessionVaultError.unavailable }; return value } }
    func save(_ session: AuthSession) throws { try lock.withLock { if failSave { throw SessionVaultError.unavailable }; value = session; saveCount += 1 } }
    func clear() throws { try lock.withLock { if failClear { throw SessionVaultError.unavailable }; value = nil; clearCount += 1 } }
    func snapshot() -> AuthSession? { lock.withLock { value } }
}

actor AuthRemoteStub: AuthRemote {
    enum Failure: Error { case rejected }
    var refreshedSession: AuthSession
    var refreshError: Error?
    var signOutError: Error?
    private(set) var refreshCount = 0
    private(set) var signOutCount = 0
    private(set) var receivedRefreshToken: String?
    private(set) var receivedAccessToken: String?

    init(refreshedSession: AuthSession) { self.refreshedSession = refreshedSession }
    func refreshSession(refreshToken: String) async throws -> AuthSession {
        refreshCount += 1; receivedRefreshToken = refreshToken
        await Task.yield()
        if let refreshError { throw refreshError }
        return refreshedSession
    }
    func signOut(accessToken: String) async throws {
        signOutCount += 1; receivedAccessToken = accessToken
        if let signOutError { throw signOutError }
    }
    func setSignOutError(_ error: Error?) { signOutError = error }
    func setRefreshError(_ error: Error?) { refreshError = error }
}

private actor AuthAsyncSignal {
    private var isSignaled = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        if isSignaled { return }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
        }
    }

    func signal() {
        guard !isSignaled else { return }
        isSignaled = true
        let pending = waiters
        waiters.removeAll(keepingCapacity: false)
        pending.forEach { $0.resume() }
    }
}

actor AuthControlledRemote: AuthRemote {
    private let refreshedSession: AuthSession
    private let blocksRefresh: Bool
    private let blocksSignOut: Bool
    private let refreshStarted = AuthAsyncSignal()
    private let refreshReleased = AuthAsyncSignal()
    private let signOutStarted = AuthAsyncSignal()
    private let signOutReleased = AuthAsyncSignal()

    init(refreshedSession: AuthSession, blocksRefresh: Bool = false, blocksSignOut: Bool = false) {
        self.refreshedSession = refreshedSession
        self.blocksRefresh = blocksRefresh
        self.blocksSignOut = blocksSignOut
    }

    func refreshSession(refreshToken _: String) async throws -> AuthSession {
        await refreshStarted.signal()
        if blocksRefresh { await refreshReleased.wait() }
        return refreshedSession
    }

    func signOut(accessToken _: String) async throws {
        await signOutStarted.signal()
        if blocksSignOut { await signOutReleased.wait() }
    }

    func waitUntilRefreshStarts() async { await refreshStarted.wait() }
    func releaseRefresh() async { await refreshReleased.signal() }
    func waitUntilSignOutStarts() async { await signOutStarted.wait() }
    func releaseSignOut() async { await signOutReleased.signal() }
}

func authSession(access: String = "access", refresh: String = "refresh",
                 expiresAt: Date = Date(timeIntervalSince1970: 2_000),
                 userID: UUID = UUID(uuidString: "11111111-1111-1111-1111-111111111111")!,
                 email: String = "person@example.com") -> AuthSession {
    .init(accessToken: access, refreshToken: refresh, expiresAt: expiresAt,
          user: .init(id: userID, email: email))
}
