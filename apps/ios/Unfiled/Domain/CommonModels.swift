import Foundation

public enum NoteType: String, Codable, CaseIterable, Sendable {
    case generic, list, log, principle, project
}

public enum PrivacyMode: String, Codable, CaseIterable, Sendable {
    case aiAssisted = "ai_assisted"
    case privateManual = "private_manual"
}

public enum ArchiveFilter: String, Codable, CaseIterable, Sendable {
    case exclude, include, only
}

public enum DeletedFilter: String, Codable, CaseIterable, Sendable {
    case exclude, only
}

public enum RevisionSource: String, Codable, CaseIterable, Sendable {
    case manual, organization, undo, `import`, interactive
}

public enum LinkType: String, Codable, CaseIterable, Sendable {
    case reference, related
}

public enum APIErrorCode: String, Codable, CaseIterable, Sendable {
    case accountDeletionFailed = "account_deletion_failed"
    case budgetExhausted = "budget_exhausted"
    case captureTooLong = "capture_too_long"
    case conflictRequiresReview = "conflict_requires_review"
    case forbidden
    case invalidCapture = "invalid_capture"
    case invalidIdempotencyKey = "invalid_idempotency_key"
    case invalidPlan = "invalid_plan"
    case notFound = "not_found"
    case offline
    case providerKeyInvalid = "provider_key_invalid"
    case providerUnavailable = "provider_unavailable"
    case rateLimited = "rate_limited"
    case staleRevision = "stale_revision"
    case structureConflict = "structure_conflict"
    case unauthorized
    case validationFailed = "validation_failed"
}

public struct PageInfo: Codable, Equatable, Sendable {
    public let hasMore: Bool
    @RequiredNullable public var nextCursor: String?

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case hasMore, nextCursor
    }

    public init(hasMore: Bool, nextCursor: String?) {
        self.hasMore = hasMore
        _nextCursor = RequiredNullable(wrappedValue: nextCursor)
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        hasMore = try container.decode(Bool.self, forKey: .hasMore)
        _nextCursor = try container.decode(RequiredNullable<String>.self, forKey: .nextCursor)
        guard nextCursor.map({ (1 ... 512).contains($0.utf16.count) }) ?? true else {
            throw DecodingError.dataCorruptedError(
                forKey: .nextCursor,
                in: container,
                debugDescription: "Pagination cursor violates the API contract"
            )
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(hasMore, forKey: .hasMore)
        try container.encode(_nextCursor, forKey: .nextCursor)
    }
}

/// Codable normally treats a missing optional key like JSON null. Contract response fields marked
/// nullable are still required, so this wrapper preserves that distinction during decoding.
@propertyWrapper
public struct RequiredNullable<Value: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public let wrappedValue: Value?
    public init(wrappedValue: Value?) { self.wrappedValue = wrappedValue }

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        wrappedValue = container.decodeNil() ? nil : try container.decode(Value.self)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        if let wrappedValue { try container.encode(wrappedValue) } else { try container.encodeNil() }
    }
}

public struct APIErrorPayload: Codable, Equatable, Sendable {
    public let code: APIErrorCode
    public let message: String
    public let requestId: String
    public let retryAfterSeconds: Int?
    public let details: [String: JSONValue]?
}

/// A tri-state update field: omit it, encode a concrete value, or encode JSON null.
public enum PatchField<Value: Encodable & Sendable>: Sendable {
    case unchanged
    case value(Value)
    case null

    public var isChanged: Bool {
        if case .unchanged = self { return false }
        return true
    }
}

public enum DomainValidationError: Error, Equatable, Sendable {
    case invalidValue(String)
}

extension KeyedEncodingContainer {
    mutating func encodePatch<T>(_ field: PatchField<T>, forKey key: Key) throws {
        switch field {
        case .unchanged: break
        case let .value(value): try encode(value, forKey: key)
        case .null: try encodeNil(forKey: key)
        }
    }
}

/// Zod response contracts use strict objects. Foundation's synthesized `Decodable` silently
/// ignores unknown object members, so response types at security-sensitive trust boundaries use
/// this helper to fail closed when the wire shape drifts.
struct StrictJSONKey: CodingKey {
    let stringValue: String
    let intValue: Int? = nil

    init?(stringValue: String) { self.stringValue = stringValue }
    init?(intValue: Int) { return nil }

    static func requireExactKeys(_ expected: [String], from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: StrictJSONKey.self)
        let actual = Set(container.allKeys.map(\.stringValue))
        guard actual == Set(expected) else {
            throw DecodingError.dataCorrupted(
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "Response keys do not match the API contract"
                )
            )
        }
    }
}
