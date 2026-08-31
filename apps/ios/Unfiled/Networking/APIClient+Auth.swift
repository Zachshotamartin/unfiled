import Foundation

public protocol AuthRemote: Sendable {
    func refreshSession(refreshToken: String) async throws -> AuthSession
    func signOut(accessToken: String) async throws
}

extension APIClient: AuthRemote {
    public func requestOTP(email: String) async throws -> AuthOTPAcceptedResponse {
        let request = AuthOTPRequest(email: email)
        guard !request.email.isEmpty, request.email.utf8.count <= 254, request.email.contains("@") else {
            throw APIClientError.invalidRequest
        }
        return try await post("/auth/otp", body: request, authenticated: false)
    }

    public func verifyOTP(email: String, code: String) async throws -> AuthSession {
        try await put("/auth/otp", body: AuthOTPVerifyRequest(email: email, code: code), authenticated: false)
    }

    public func verifyAuth(email: String, code: String) async throws -> AuthSession {
        try await put("/auth/verify", body: AuthOTPVerifyRequest(email: email, code: code), authenticated: false)
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
