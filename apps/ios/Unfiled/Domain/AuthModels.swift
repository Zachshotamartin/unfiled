import Foundation

public struct AuthPasswordRequest: Codable, Equatable, Sendable {
    public static let minimumPasswordLength = 8
    public static let maximumPasswordLength = 72

    public let email: String
    public let password: String

    public init(email: String, password: String) throws {
        let normalized = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !normalized.isEmpty,
              normalized.utf8.count <= 254,
              normalized.contains("@"),
              (Self.minimumPasswordLength ... Self.maximumPasswordLength).contains(password.utf8.count)
        else { throw DomainValidationError.invalidValue("Invalid email or password") }
        self.email = normalized
        self.password = password
    }
}

public struct AuthRefreshRequest: Codable, Equatable, Sendable {
    public let refreshToken: String
    public init(refreshToken: String) { self.refreshToken = refreshToken }
}

public struct AuthUser: Codable, Equatable, Sendable {
    public let id: UUID
    public let email: String

    public init(id: UUID, email: String) { self.id = id; self.email = email }

    private enum CodingKeys: String, CodingKey { case id, email }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(UUID.self, forKey: .id)
        let email = try c.decode(String.self, forKey: .email)
        guard Self.isNormalizedEmail(email) else {
            throw DecodingError.dataCorruptedError(forKey: .email, in: c, debugDescription: "Invalid normalized email")
        }
        self.email = email
    }

    private static func isNormalizedEmail(_ value: String) -> Bool {
        guard value == value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              (3 ... 254).contains(value.utf8.count), !value.hasPrefix("."), !value.contains("..") else { return false }
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".") &&
            !parts[1].hasPrefix("-") && !parts[1].hasSuffix("-")
    }
}

public struct AuthSession: Codable, Equatable, Sendable {
    public let accessToken: String
    public let refreshToken: String
    public let expiresAt: Date
    public let user: AuthUser

    public init(accessToken: String, refreshToken: String, expiresAt: Date, user: AuthUser) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.user = user
    }

    public var isStructurallyValid: Bool {
        !accessToken.isEmpty && (1 ... 8_192).contains(refreshToken.utf8.count)
    }

    private enum CodingKeys: String, CodingKey { case accessToken, refreshToken, expiresAt, user }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        accessToken = try c.decode(String.self, forKey: .accessToken)
        refreshToken = try c.decode(String.self, forKey: .refreshToken)
        expiresAt = try c.decode(Date.self, forKey: .expiresAt)
        user = try c.decode(AuthUser.self, forKey: .user)
        guard isStructurallyValid else {
            throw DecodingError.dataCorruptedError(forKey: .refreshToken, in: c, debugDescription: "Invalid session token")
        }
    }
}

public struct AuthSessionResponse: Codable, Equatable, Sendable {
    public let user: AuthUser
}

public struct AuthSignOutResponse: Codable, Equatable, Sendable {
    public let signedOut: Bool

    private enum CodingKeys: String, CodingKey { case signedOut }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard try c.decode(Bool.self, forKey: .signedOut) else {
            throw DecodingError.dataCorruptedError(forKey: .signedOut, in: c, debugDescription: "Expected true")
        }
        signedOut = true
    }
}

