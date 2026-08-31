import Foundation

public enum AuthenticationError: Error, Equatable, Sendable {
    case signedOut
    case sessionStorageUnavailable
    case refreshFailed
}

public actor AuthSessionManager: AccessTokenProviding {
    public typealias Clock = @Sendable () -> Date

    private struct RefreshFlight {
        let id: UUID
        let generation: UInt64
        let userID: UUID
        let refreshToken: String
        let task: Task<AuthSession, Error>
    }

    private let vault: any SessionVault
    private let remote: any AuthRemote
    private let clock: Clock
    private let refreshLeeway: TimeInterval
    private var session: AuthSession?
    private var generation: UInt64 = 0
    private var refreshFlight: RefreshFlight?

    public init(vault: any SessionVault, remote: any AuthRemote,
                refreshLeeway: TimeInterval = 60,
                clock: @escaping Clock = { Date() }) throws {
        guard refreshLeeway >= 0 else { throw AuthenticationError.sessionStorageUnavailable }
        self.vault = vault; self.remote = remote; self.refreshLeeway = refreshLeeway; self.clock = clock
        do { session = try vault.load() }
        catch { throw AuthenticationError.sessionStorageUnavailable }
    }

    public func accept(_ session: AuthSession) throws {
        guard session.isStructurallyValid else { throw AuthenticationError.refreshFailed }
        do { try vault.save(session) }
        catch { throw AuthenticationError.sessionStorageUnavailable }
        invalidateRefreshes()
        self.session = session
    }

    public func currentUser() -> AuthUser? { session?.user }

    public func accessToken() async throws -> String {
        guard let session else { throw AuthenticationError.signedOut }
        if session.expiresAt.timeIntervalSince(clock()) > refreshLeeway { return session.accessToken }
        return try await refresh(
            refreshToken: session.refreshToken,
            userID: session.user.id,
            expectedGeneration: generation
        ).accessToken
    }

    public func accessTokenCredential() async throws -> AccessTokenCredential {
        let token = try await accessToken()
        guard let session, session.accessToken == token else {
            throw AuthenticationError.signedOut
        }
        return AccessTokenCredential(
            token: token,
            userID: session.user.id,
            sessionGeneration: generation
        )
    }

    public func refreshAfterUnauthorized(rejectedToken: String) async throws -> String {
        guard let session else { throw AuthenticationError.signedOut }
        if session.accessToken != rejectedToken { return session.accessToken }
        return try await refresh(
            refreshToken: session.refreshToken,
            userID: session.user.id,
            expectedGeneration: generation
        ).accessToken
    }

    public func refreshAfterUnauthorized(
        rejectedCredential: AccessTokenCredential
    ) async throws -> AccessTokenCredential {
        guard let session,
              generation == rejectedCredential.sessionGeneration,
              session.user.id == rejectedCredential.userID else {
            throw AuthenticationError.signedOut
        }
        let token: String
        if session.accessToken != rejectedCredential.token {
            token = session.accessToken
        } else {
            token = try await refresh(
                refreshToken: session.refreshToken,
                userID: session.user.id,
                expectedGeneration: generation
            ).accessToken
        }
        guard let currentSession = self.session,
              generation == rejectedCredential.sessionGeneration,
              currentSession.user.id == rejectedCredential.userID,
              currentSession.accessToken == token else {
            throw AuthenticationError.signedOut
        }
        return AccessTokenCredential(
            token: token,
            userID: currentSession.user.id,
            sessionGeneration: generation
        )
    }

    public func signOut() async throws {
        let accessToken = session?.accessToken
        invalidateRefreshes()
        session = nil

        var storageFailure = false
        do { try vault.clear() }
        catch { storageFailure = true }

        var remoteFailure: Error?
        if let accessToken {
            do { try await remote.signOut(accessToken: accessToken) }
            catch { remoteFailure = error }
        }

        if storageFailure { throw AuthenticationError.sessionStorageUnavailable }
        if remoteFailure != nil { throw AuthenticationError.refreshFailed }
    }

    public func clearLocalSession() throws {
        invalidateRefreshes()
        session = nil
        do { try vault.clear() }
        catch { throw AuthenticationError.sessionStorageUnavailable }
    }

    private func refresh(
        refreshToken: String,
        userID: UUID,
        expectedGeneration: UInt64
    ) async throws -> AuthSession {
        guard generation == expectedGeneration,
              let currentSession = session,
              currentSession.user.id == userID,
              currentSession.refreshToken == refreshToken
        else {
            throw AuthenticationError.signedOut
        }

        let flight: RefreshFlight
        if let active = refreshFlight {
            guard active.generation == expectedGeneration,
                  active.userID == userID,
                  active.refreshToken == refreshToken
            else {
                throw AuthenticationError.refreshFailed
            }
            flight = active
        } else {
            let remote = self.remote
            let task = Task<AuthSession, Error> {
                try await remote.refreshSession(refreshToken: refreshToken)
            }
            flight = RefreshFlight(
                id: UUID(),
                generation: expectedGeneration,
                userID: userID,
                refreshToken: refreshToken,
                task: task
            )
            refreshFlight = flight
        }

        do {
            let refreshed = try await flight.task.value

            guard generation == expectedGeneration else {
                throw AuthenticationError.signedOut
            }

            // A concurrent waiter may already have committed this exact flight.
            guard refreshFlight?.id == flight.id else {
                guard session == refreshed else { throw AuthenticationError.refreshFailed }
                return refreshed
            }

            guard refreshed.isStructurallyValid,
                  refreshed.expiresAt > clock(),
                  refreshed.user.id == userID
            else {
                throw AuthenticationError.refreshFailed
            }
            do { try vault.save(refreshed) }
            catch { throw AuthenticationError.sessionStorageUnavailable }
            session = refreshed
            refreshFlight = nil
            return refreshed
        } catch {
            guard generation == expectedGeneration else {
                throw AuthenticationError.signedOut
            }
            if refreshFlight?.id == flight.id {
                refreshFlight = nil
            }
            if case APIClientError.http(status: 401, code: _, requestId: _, retryAfterSeconds: _) = error {
                invalidateRefreshes()
                session = nil
                try? vault.clear()
            }
            if let typed = error as? AuthenticationError { throw typed }
            if let typed = error as? APIClientError { throw typed }
            throw AuthenticationError.refreshFailed
        }
    }

    private func invalidateRefreshes() {
        generation &+= 1
        refreshFlight?.task.cancel()
        refreshFlight = nil
    }
}

extension AuthSessionManager: CaptureProfileAuthorizing {
    func authorizesCaptureProfile(_ profileID: UUID) -> Bool {
        session?.user.id == profileID
    }

    func captureAccessToken(for profileID: UUID) async throws -> String {
        guard session?.user.id == profileID else { throw AuthenticationError.signedOut }
        return try await accessToken()
    }

    func refreshCaptureAccessToken(
        for profileID: UUID,
        rejectedToken: String
    ) async throws -> String {
        guard session?.user.id == profileID else { throw AuthenticationError.signedOut }
        let token = try await refreshAfterUnauthorized(rejectedToken: rejectedToken)
        guard session?.user.id == profileID else { throw AuthenticationError.signedOut }
        return token
    }
}
