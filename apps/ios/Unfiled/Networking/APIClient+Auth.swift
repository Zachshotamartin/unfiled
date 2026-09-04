import Foundation

public protocol AuthRemote: Sendable {
    func refreshSession(refreshToken: String) async throws -> AuthSession
    func signOut(accessToken: String) async throws
}

extension APIClient: AuthRemote {
    /// Creates the account. A deployment that confirms nothing answers with a session; one that
    /// confirms addresses answers with the address it just emailed a code to. The account exists
    /// either way, so neither answer is a failure.
    public func signUp(email: String, password: String) async throws -> AuthSignUpOutcome {
        let request: AuthPasswordRequest
        do { request = try AuthPasswordRequest(email: email, password: password) } catch { throw APIClientError.invalidRequest }
        return try await post("/auth/sign-up", body: request, authenticated: false)
    }

    /// Exchanges the emailed code for a session. A code that is not six digits is refused here so it
    /// never spends one of the service's hourly attempts.
    public func verifyEmail(email: String, code: String) async throws -> AuthSession {
        let request: AuthVerifyRequest
        do { request = try AuthVerifyRequest(email: email, code: code) } catch { throw APIClientError.invalidRequest }
        return try await post("/auth/verify", body: request, authenticated: false)
    }

    /// Asks the service to email another code. The reply says only that the request was accepted.
    public func resendVerification(email: String) async throws {
        let request: AuthResendRequest
        do { request = try AuthResendRequest(email: email) } catch { throw APIClientError.invalidRequest }
        let _: AuthResendResponse = try await post("/auth/resend", body: request, authenticated: false)
    }

    public func signIn(email: String, password: String) async throws -> AuthSession {
        let request: AuthPasswordRequest
        do { request = try AuthPasswordRequest(email: email, password: password) } catch { throw APIClientError.invalidRequest }
        return try await post("/auth/sign-in", body: request, authenticated: false)
    }

    public func refreshSession(refreshToken: String) async throws -> AuthSession {
        guard (1 ... 8_192).contains(refreshToken.utf8.count) else { throw APIClientError.invalidRequest }
        return try await post("/auth/refresh", body: AuthRefreshRequest(refreshToken: refreshToken), authenticated: false)
    }

    public func authSession(accessToken: String? = nil) async throws -> AuthSessionResponse {
        try await get("/auth/session", explicitToken: accessToken)
    }

    public func signOut(accessToken: String) async throws {
        let _: AuthSignOutResponse = try await postEmpty("/auth/sign-out", explicitToken: accessToken)
    }
}
