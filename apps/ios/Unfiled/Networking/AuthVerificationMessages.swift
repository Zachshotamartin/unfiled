import Foundation

/// The address form the service hands back and accepts: already trimmed and lower-cased, one `@`,
/// and a dotted domain. `AuthUser` holds a session's address to the same rule, so a reply is checked
/// identically whether the address arrives inside a session or beside a confirmation flag.
enum AuthEmailContract {
    static let maximumByteCount = 254

    static func isNormalized(_ value: String) -> Bool {
        guard value == value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(),
              (3 ... maximumByteCount).contains(value.utf8.count),
              !value.hasPrefix("."),
              !value.contains("..")
        else { return false }
        let parts = value.split(separator: "@", omittingEmptySubsequences: false)
        return parts.count == 2 && !parts[0].isEmpty && parts[1].contains(".") &&
            !parts[1].hasPrefix("-") && !parts[1].hasSuffix("-")
    }
}

/// The six digits the service emails. The rule lives here rather than in the screen because the
/// client refuses a malformed code before it reaches the wire: every attempt the service sees spends
/// one of the owner's hourly attempts, and a code that could not possibly be right must not cost one.
enum AuthVerificationCodeContract {
    static let length = 6

    /// Keeps only the ASCII digits, and never more than a code's worth. The keyboard's one-time-code
    /// autofill can deliver the digits with spaces or a dash around them, and a paste can carry the
    /// whole sentence they were written in.
    static func digits(_ rawValue: String) -> String {
        String(rawValue.filter { $0.isASCII && $0.isNumber }.prefix(length))
    }

    static func isComplete(_ value: String) -> Bool {
        value.count == length && value.allSatisfy { $0.isASCII && $0.isNumber }
    }
}

/// Creating an account has two lawful outcomes. A deployment that confirms nothing hands back a
/// session; a deployment that confirms addresses emails six digits and hands back the address it sent
/// them to. The same build talks to both, so the reply is read as a union rather than as a session
/// with a failure case: a withheld session is not a fault.
public enum AuthSignUpOutcome: Equatable, Sendable {
    case session(AuthSession)
    case verificationRequired(email: String)
}

extension AuthSignUpOutcome: Decodable {
    private enum CodingKeys: String, CodingKey { case verificationRequired, email }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        // The confirmation arm is the discriminated one. Anything without the flag must be a session,
        // and `AuthSession` applies its own structural checks to it.
        guard container.contains(.verificationRequired) else {
            self = .session(try AuthSession(from: decoder))
            return
        }
        guard try container.decode(Bool.self, forKey: .verificationRequired) else {
            throw DecodingError.dataCorruptedError(
                forKey: .verificationRequired,
                in: container,
                debugDescription: "Expected true"
            )
        }
        let email = try container.decode(String.self, forKey: .email)
        guard AuthEmailContract.isNormalized(email) else {
            throw DecodingError.dataCorruptedError(
                forKey: .email,
                in: container,
                debugDescription: "Invalid normalized email"
            )
        }
        self = .verificationRequired(email: email)
    }
}

public struct AuthVerifyRequest: Codable, Equatable, Sendable {
    public static let codeLength = AuthVerificationCodeContract.length

    public let email: String
    public let code: String

    public init(email: String, code: String) throws {
        let normalizedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let trimmedCode = code.trimmingCharacters(in: .whitespacesAndNewlines)
        guard AuthEmailContract.isNormalized(normalizedEmail),
              AuthVerificationCodeContract.isComplete(trimmedCode)
        else { throw DomainValidationError.invalidValue("Invalid email or verification code") }
        self.email = normalizedEmail
        self.code = trimmedCode
    }
}

public struct AuthResendRequest: Codable, Equatable, Sendable {
    public let email: String

    public init(email: String) throws {
        let normalizedEmail = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard AuthEmailContract.isNormalized(normalizedEmail) else {
            throw DomainValidationError.invalidValue("Invalid email")
        }
        self.email = normalizedEmail
    }
}

/// Content-free by design: the service answers a resend the same way whether or not the address has
/// an account awaiting confirmation, so the reply carries no fact beyond "the request was accepted".
public struct AuthResendResponse: Codable, Equatable, Sendable {
    public let sent: Bool

    private enum CodingKeys: String, CodingKey { case sent }
    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard try container.decode(Bool.self, forKey: .sent) else {
            throw DecodingError.dataCorruptedError(
                forKey: .sent,
                in: container,
                debugDescription: "Expected true"
            )
        }
        sent = true
    }
}
