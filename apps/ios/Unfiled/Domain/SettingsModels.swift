import Foundation

public enum OrganizationMode: String, Codable, CaseIterable, Sendable {
    case cautious, balanced, automatic
}

public enum RoutingEffort: String, Codable, CaseIterable, Sendable {
    case economical, standard, thorough
}

public enum ExpansionStyle: String, Codable, CaseIterable, Sendable {
    case off, brief, detailed
}

public enum AIProvider: String, Codable, CaseIterable, Sendable {
    case openai, anthropic
}

public enum ProviderMode: String, Codable, CaseIterable, Sendable {
    case appDefault = "app_default"
    case byok
}

public enum ProviderKeyStatus: String, Codable, CaseIterable, Sendable {
    case active, invalid, revoked
}

public struct UserSettings: Codable, Equatable, Sendable {
    public let settingsRevision: Int
    public let organizationMode: OrganizationMode
    public let providerMode: ProviderMode
    @RequiredNullable public var byokProvider: AIProvider?
    public let byokFallbackToApp: Bool
    public let routingEffort: RoutingEffort
    public let expansionStyle: ExpansionStyle
    public let timezone: String
    public let locale: String
    public let updatedAt: Date

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case settingsRevision, organizationMode, providerMode, byokProvider, byokFallbackToApp
        case routingEffort, expansionStyle, timezone, locale, updatedAt
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        settingsRevision = try container.decode(Int.self, forKey: .settingsRevision)
        organizationMode = try container.decode(OrganizationMode.self, forKey: .organizationMode)
        providerMode = try container.decode(ProviderMode.self, forKey: .providerMode)
        _byokProvider = try container.decode(
            RequiredNullable<AIProvider>.self,
            forKey: .byokProvider
        )
        byokFallbackToApp = try container.decode(Bool.self, forKey: .byokFallbackToApp)
        routingEffort = try container.decode(RoutingEffort.self, forKey: .routingEffort)
        expansionStyle = try container.decode(ExpansionStyle.self, forKey: .expansionStyle)
        timezone = try container.decode(String.self, forKey: .timezone)
        locale = try container.decode(String.self, forKey: .locale)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)

        let providerSelectionIsValid = switch providerMode {
        case .appDefault: byokProvider == nil && !byokFallbackToApp
        case .byok: byokProvider != nil
        }
        guard settingsRevision > 0,
              providerSelectionIsValid,
              (1 ... 100).contains(timezone.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count),
              Self.isValidLocale(locale) else {
            throw DecodingError.dataCorruptedError(
                forKey: .providerMode,
                in: container,
                debugDescription: "User settings violate the API contract"
            )
        }
    }

    static func isValidLocale(_ value: String) -> Bool {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (2 ... 35).contains(trimmed.utf16.count) else { return false }
        return trimmed.range(
            of: #"^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$"#,
            options: .regularExpression
        ) != nil
    }
}

public struct UserSettingsResponse: Codable, Equatable, Sendable {
    public let settings: UserSettings

    private enum CodingKeys: String, CodingKey, CaseIterable { case settings }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        settings = try decoder.container(keyedBy: CodingKeys.self)
            .decode(UserSettings.self, forKey: .settings)
    }
}

public struct UserSettingsUpdateRequest: Encodable, Sendable {
    public let expectedSettingsRevision: Int
    public let idempotencyKey: String
    public let organizationMode: OrganizationMode?
    public let providerMode: ProviderMode?
    public let byokProvider: PatchField<AIProvider>
    public let byokFallbackToApp: Bool?
    public let routingEffort: RoutingEffort?
    public let expansionStyle: ExpansionStyle?
    public let timezone: String?
    public let locale: String?

    private enum CodingKeys: String, CodingKey {
        case expectedSettingsRevision, idempotencyKey, organizationMode, providerMode
        case byokProvider, byokFallbackToApp, routingEffort, expansionStyle, timezone, locale
    }

    public init(
        expectedSettingsRevision: Int,
        idempotencyKey: String,
        organizationMode: OrganizationMode? = nil,
        providerMode: ProviderMode? = nil,
        byokProvider: PatchField<AIProvider> = .unchanged,
        byokFallbackToApp: Bool? = nil,
        routingEffort: RoutingEffort? = nil,
        expansionStyle: ExpansionStyle? = nil,
        timezone: String? = nil,
        locale: String? = nil
    ) throws {
        let hasChange = organizationMode != nil || providerMode != nil || byokProvider.isChanged
            || byokFallbackToApp != nil || routingEffort != nil || expansionStyle != nil
            || timezone != nil || locale != nil
        guard expectedSettingsRevision > 0,
              hasChange,
              timezone.map({ (1 ... 100).contains($0.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count) }) ?? true,
              locale.map(UserSettings.isValidLocale) ?? true else {
            throw DomainValidationError.invalidValue("Settings update violates the API contract")
        }
        self.expectedSettingsRevision = expectedSettingsRevision
        self.idempotencyKey = idempotencyKey
        self.organizationMode = organizationMode
        self.providerMode = providerMode
        self.byokProvider = byokProvider
        self.byokFallbackToApp = byokFallbackToApp
        self.routingEffort = routingEffort
        self.expansionStyle = expansionStyle
        self.timezone = timezone
        self.locale = locale
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(expectedSettingsRevision, forKey: .expectedSettingsRevision)
        try container.encode(idempotencyKey, forKey: .idempotencyKey)
        try container.encodeIfPresent(organizationMode, forKey: .organizationMode)
        try container.encodeIfPresent(providerMode, forKey: .providerMode)
        try container.encodePatch(byokProvider, forKey: .byokProvider)
        try container.encodeIfPresent(byokFallbackToApp, forKey: .byokFallbackToApp)
        try container.encodeIfPresent(routingEffort, forKey: .routingEffort)
        try container.encodeIfPresent(expansionStyle, forKey: .expansionStyle)
        try container.encodeIfPresent(timezone, forKey: .timezone)
        try container.encodeIfPresent(locale, forKey: .locale)
    }
}

public struct UserSettingsUpdateResponse: Codable, Equatable, Sendable {
    public let settings: UserSettings
    public let replayed: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable { case settings, replayed }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        settings = try container.decode(UserSettings.self, forKey: .settings)
        replayed = try container.decode(Bool.self, forKey: .replayed)
    }
}

public struct ProviderKeyMetadata: Codable, Equatable, Sendable {
    public let provider: AIProvider
    public let lastFour: String
    public let status: ProviderKeyStatus
    public let credentialRevision: Int
    @RequiredNullable public var validatedAt: Date?
    public let updatedAt: Date

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case provider, lastFour, status, credentialRevision, validatedAt, updatedAt
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decode(AIProvider.self, forKey: .provider)
        lastFour = try container.decode(String.self, forKey: .lastFour)
        status = try container.decode(ProviderKeyStatus.self, forKey: .status)
        credentialRevision = try container.decode(Int.self, forKey: .credentialRevision)
        _validatedAt = try container.decode(RequiredNullable<Date>.self, forKey: .validatedAt)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)
        guard lastFour.utf16.count == 4 else {
            throw DecodingError.dataCorruptedError(
                forKey: .lastFour,
                in: container,
                debugDescription: "Provider-key metadata violates the API contract"
            )
        }
        guard credentialRevision > 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .credentialRevision,
                in: container,
                debugDescription: "Provider-key credential revision must be positive"
            )
        }
    }
}

public struct ProviderKeyResponse: Codable, Equatable, Sendable {
    @RequiredNullable public var providerKey: ProviderKeyMetadata?

    private enum CodingKeys: String, CodingKey, CaseIterable { case providerKey }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        _providerKey = try decoder.container(keyedBy: CodingKeys.self)
            .decode(RequiredNullable<ProviderKeyMetadata>.self, forKey: .providerKey)
    }
}

public struct ProviderKeyPutRequest: Encodable, Sendable {
    public let idempotencyKey: String
    public let provider: AIProvider
    public let apiKey: String

    public init(idempotencyKey: String, provider: AIProvider, apiKey: String) throws {
        guard (20 ... 500).contains(apiKey.utf16.count) else {
            throw DomainValidationError.invalidValue("Provider key length is invalid")
        }
        self.idempotencyKey = idempotencyKey
        self.provider = provider
        self.apiKey = apiKey
    }
}

public struct ProviderKeyPutResponse: Codable, Equatable, Sendable {
    public let providerKey: ProviderKeyMetadata
    public let replayed: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable { case providerKey, replayed }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        providerKey = try container.decode(ProviderKeyMetadata.self, forKey: .providerKey)
        replayed = try container.decode(Bool.self, forKey: .replayed)
    }
}

public struct ProviderKeyDeleteRequest: Codable, Equatable, Sendable {
    public let idempotencyKey: String
    public let provider: AIProvider

    public init(idempotencyKey: String, provider: AIProvider) {
        self.idempotencyKey = idempotencyKey
        self.provider = provider
    }
}

public struct ProviderKeyDeleteResponse: Codable, Equatable, Sendable {
    public let provider: AIProvider
    public let deleted: Bool
    public let replayed: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable { case provider, deleted, replayed }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decode(AIProvider.self, forKey: .provider)
        deleted = try container.decode(Bool.self, forKey: .deleted)
        replayed = try container.decode(Bool.self, forKey: .replayed)
        guard deleted else {
            throw DecodingError.dataCorruptedError(
                forKey: .deleted,
                in: container,
                debugDescription: "Provider-key deletion response must confirm deletion"
            )
        }
    }
}
