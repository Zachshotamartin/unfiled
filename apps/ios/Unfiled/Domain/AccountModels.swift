import Foundation
import Security

public struct AccountDeletionToken: Codable, Equatable, Hashable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible
{
    private let value: String

    /// The capability is exposed only for secure persistence/recovery flows.
    /// Logging uses the redacted descriptions below.
    public var rawValue: String { value }
    public var description: String { "[REDACTED account-deletion capability]" }
    public var debugDescription: String { description }

    public init(validating value: String) throws {
        let prefix = "delete_"
        guard value.hasPrefix(prefix) else {
            throw DomainValidationError.invalidValue("Invalid account-deletion capability")
        }
        let encoded = String(value.dropFirst(prefix.count))
        guard encoded.utf8.count == 43,
              encoded.utf8.allSatisfy({ byte in
                  (48 ... 57).contains(byte) || (65 ... 90).contains(byte)
                      || (97 ... 122).contains(byte) || byte == 45 || byte == 95
              }),
              encoded.last.map({ "AEIMQUYcgkosw048".contains($0) }) == true,
              let decoded = Data(
                  base64Encoded: encoded
                      .replacingOccurrences(of: "-", with: "+")
                      .replacingOccurrences(of: "_", with: "/") + "="
              ),
              decoded.count == 32,
              Self.base64URL(decoded) == encoded else {
            throw DomainValidationError.invalidValue("Invalid account-deletion capability")
        }
        self.value = value
    }

    public static func generate() throws -> Self {
        var bytes = Array(repeating: UInt8(0), count: 32)
        let status = bytes.withUnsafeMutableBytes { buffer in
            SecRandomCopyBytes(kSecRandomDefault, buffer.count, buffer.baseAddress!)
        }
        guard status == errSecSuccess else { throw APIClientError.invalidRequest }
        return try Self(validating: "delete_\(base64URL(Data(bytes)))")
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        try self.init(validating: container.decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(value)
    }

    private static func base64URL(_ bytes: Data) -> String {
        bytes.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

public struct AccountDeleteRequest: Codable, Equatable, Sendable {
    public let confirmation: String
    public let idempotencyKey: AccountDeletionToken

    public init(idempotencyKey: AccountDeletionToken) {
        confirmation = "DELETE"
        self.idempotencyKey = idempotencyKey
    }
}

public struct AccountDeletionReceiptReplayRequest: Codable, Equatable, Sendable {
    public let idempotencyKey: AccountDeletionToken

    public init(idempotencyKey: AccountDeletionToken) {
        self.idempotencyKey = idempotencyKey
    }
}

public struct AccountDeletionReceipt: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let deletedAt: Date
    public let backupExpiresAt: Date
    public let receiptExpiresAt: Date
    public let backupRetentionDays: Int
    public let liveDataDeleted: Bool
    public let sessionsRevoked: Bool
    public let reRegistrationStartsFresh: Bool
    public let deletedRecordCounts: [String: Int]
    public let replayed: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case schemaVersion, deletedAt, backupExpiresAt, receiptExpiresAt
        case backupRetentionDays, liveDataDeleted, sessionsRevoked
        case reRegistrationStartsFresh, deletedRecordCounts, replayed
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        deletedAt = try container.decode(Date.self, forKey: .deletedAt)
        backupExpiresAt = try container.decode(Date.self, forKey: .backupExpiresAt)
        receiptExpiresAt = try container.decode(Date.self, forKey: .receiptExpiresAt)
        backupRetentionDays = try container.decode(Int.self, forKey: .backupRetentionDays)
        liveDataDeleted = try container.decode(Bool.self, forKey: .liveDataDeleted)
        sessionsRevoked = try container.decode(Bool.self, forKey: .sessionsRevoked)
        reRegistrationStartsFresh = try container.decode(
            Bool.self,
            forKey: .reRegistrationStartsFresh
        )
        deletedRecordCounts = try container.decode([String: Int].self, forKey: .deletedRecordCounts)
        replayed = try container.decode(Bool.self, forKey: .replayed)

        let day: TimeInterval = 24 * 60 * 60
        guard schemaVersion == 1,
              backupRetentionDays == 30,
              liveDataDeleted,
              sessionsRevoked,
              reRegistrationStartsFresh,
              abs(backupExpiresAt.timeIntervalSince(deletedAt) - 30 * day) < 0.001,
              abs(receiptExpiresAt.timeIntervalSince(deletedAt) - 31 * day) < 0.001,
              deletedRecordCounts.count <= 128,
              deletedRecordCounts.allSatisfy({ key, count in
                  count >= 0 && Self.validAuditKey(key)
              }) else {
            throw DecodingError.dataCorruptedError(
                forKey: .deletedRecordCounts,
                in: container,
                debugDescription: "Account deletion receipt violates the API contract"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(deletedAt, forKey: .deletedAt)
        try container.encode(backupExpiresAt, forKey: .backupExpiresAt)
        try container.encode(receiptExpiresAt, forKey: .receiptExpiresAt)
        try container.encode(backupRetentionDays, forKey: .backupRetentionDays)
        try container.encode(liveDataDeleted, forKey: .liveDataDeleted)
        try container.encode(sessionsRevoked, forKey: .sessionsRevoked)
        try container.encode(reRegistrationStartsFresh, forKey: .reRegistrationStartsFresh)
        try container.encode(deletedRecordCounts, forKey: .deletedRecordCounts)
        try container.encode(replayed, forKey: .replayed)
    }

    private static func validAuditKey(_ value: String) -> Bool {
        let parts = value.split(separator: ".", omittingEmptySubsequences: false)
        guard (2 ... 3).contains(parts.count) else { return false }
        return parts.allSatisfy { part in
            guard let first = part.utf8.first, (97 ... 122).contains(first) else { return false }
            return part.utf8.dropFirst().allSatisfy { byte in
                (97 ... 122).contains(byte) || (48 ... 57).contains(byte) || byte == 95
            }
        }
    }
}
