import Foundation

public protocol AuthRemote: Sendable {
    func refreshSession(refreshToken: String) async throws -> AuthSession
    func signOut(accessToken: String) async throws
}

extension APIClient: AuthRemote {
    public func signUp(email: String, password: String) async throws -> AuthSession {
        let request: AuthPasswordRequest
        do { request = try AuthPasswordRequest(email: email, password: password) } catch { throw APIClientError.invalidRequest }
        return try await post("/auth/sign-up", body: request, authenticated: false)
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
