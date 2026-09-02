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

    var displayName: String {
        switch self {
        case .openai: "OpenAI"
        case .anthropic: "Claude"
        }
    }
}

public enum AIModelSelection: String, Codable, CaseIterable, Sendable {
    case automatic = "auto"
    case gpt56Luna = "gpt-5.6-luna"
    case gpt56Terra = "gpt-5.6-terra"
    case gpt56Sol = "gpt-5.6-sol"
    case claudeSonnet5 = "claude-sonnet-5"
    case claudeOpus5 = "claude-opus-5"

    func isCompatible(with provider: AIProvider) -> Bool {
        switch (self, provider) {
        case (.automatic, _),
             (.gpt56Luna, .openai),
             (.gpt56Terra, .openai),
             (.gpt56Sol, .openai),
             (.claudeSonnet5, .anthropic),
             (.claudeOpus5, .anthropic):
            true
        default:
            false
        }
    }
}

/// Native mirror of `AI_MODEL_CATALOG` (`organization-model-registry-v2`) in
/// `packages/contracts/src/settings.ts`. Adding or retiring a model changes both sides together.
enum AIModelRegistry {
    static let version = "organization-model-registry-v2"

    static func selections(for provider: AIProvider) -> [AIModelSelection] {
        switch provider {
        case .openai: [.automatic, .gpt56Luna, .gpt56Terra, .gpt56Sol]
        case .anthropic: [.automatic, .claudeSonnet5, .claudeOpus5]
        }
    }

    static func automaticModel(for provider: AIProvider, effort: RoutingEffort) -> AIModelSelection {
        switch (provider, effort) {
        case (.openai, .economical): .gpt56Luna
        case (.openai, .standard): .gpt56Terra
        case (.openai, .thorough): .gpt56Sol
        case (.anthropic, .economical), (.anthropic, .standard): .claudeSonnet5
        case (.anthropic, .thorough): .claudeOpus5
        }
    }

    static func label(for model: AIModelSelection) -> String {
        switch model {
        case .automatic: "Automatic"
        case .gpt56Luna: "GPT-5.6 Luna"
        case .gpt56Terra: "GPT-5.6 Terra"
        case .gpt56Sol: "GPT-5.6 Sol"
        case .claudeSonnet5: "Claude Sonnet 5"
        case .claudeOpus5: "Claude Opus 5"
        }
    }

    static func detail(for model: AIModelSelection) -> String {
        switch model {
        case .automatic: "Matches the model to the selected effort."
        case .gpt56Luna: "Fastest GPT-5.6 choice for familiar filing and lower cost."
        case .gpt56Terra: "Balanced GPT-5.6 quality, latency, and cost."
        case .gpt56Sol: "Most capable GPT-5.6 choice with higher latency and cost."
        case .claudeSonnet5: "Balanced Claude quality, latency, and cost."
        case .claudeOpus5: "Most capable Claude choice with higher latency and cost."
        }
    }

    /// Exact choices whose per-capture cost exceeds the automatic mapping for lower efforts.
    /// The UI names them before save so a user-funded key is never surprised.
    static func isHigherCost(_ model: AIModelSelection) -> Bool {
        switch model {
        case .gpt56Sol, .claudeOpus5: true
        case .automatic, .gpt56Luna, .gpt56Terra, .claudeSonnet5: false
        }
    }
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
    public let modelSelection: AIModelSelection
    public let byokFallbackToApp: Bool
    public let routingEffort: RoutingEffort
    public let expansionStyle: ExpansionStyle
    public let timezone: String
    public let locale: String
    public let updatedAt: Date

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case settingsRevision, organizationMode, providerMode, byokProvider, modelSelection
        case byokFallbackToApp, routingEffort, expansionStyle, timezone, locale, updatedAt
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
        modelSelection = try container.decode(AIModelSelection.self, forKey: .modelSelection)
        byokFallbackToApp = try container.decode(Bool.self, forKey: .byokFallbackToApp)
        routingEffort = try container.decode(RoutingEffort.self, forKey: .routingEffort)
        expansionStyle = try container.decode(ExpansionStyle.self, forKey: .expansionStyle)
        timezone = try container.decode(String.self, forKey: .timezone)
        locale = try container.decode(String.self, forKey: .locale)
        updatedAt = try container.decode(Date.self, forKey: .updatedAt)

        let providerSelectionIsValid = switch providerMode {
        case .appDefault:
            byokProvider == nil && modelSelection == .automatic && !byokFallbackToApp
        case .byok:
            byokProvider.map { modelSelection.isCompatible(with: $0) } ?? false
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
    public let modelSelection: AIModelSelection?
    public let byokFallbackToApp: Bool?
    public let routingEffort: RoutingEffort?
    public let expansionStyle: ExpansionStyle?
    public let timezone: String?
    public let locale: String?

    private enum CodingKeys: String, CodingKey {
        case expectedSettingsRevision, idempotencyKey, organizationMode, providerMode
        case byokProvider, modelSelection, byokFallbackToApp, routingEffort, expansionStyle
        case timezone, locale
    }

    public init(
        expectedSettingsRevision: Int,
        idempotencyKey: String,
        organizationMode: OrganizationMode? = nil,
        providerMode: ProviderMode? = nil,
        byokProvider: PatchField<AIProvider> = .unchanged,
        modelSelection: AIModelSelection? = nil,
        byokFallbackToApp: Bool? = nil,
        routingEffort: RoutingEffort? = nil,
        expansionStyle: ExpansionStyle? = nil,
        timezone: String? = nil,
        locale: String? = nil
    ) throws {
        let normalizedTimezone = timezone?.trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedLocale = locale?.trimmingCharacters(in: .whitespacesAndNewlines)
        let hasChange = organizationMode != nil || providerMode != nil || byokProvider.isChanged
            || modelSelection != nil
            || byokFallbackToApp != nil || routingEffort != nil || expansionStyle != nil
            || timezone != nil || locale != nil
        let providerSelectionIsCoherent: Bool
        switch (providerMode, byokProvider, byokFallbackToApp) {
        case (.some(.appDefault), .value(_), _),
             (.some(.appDefault), _, .some(true)),
             (.some(.byok), .null, _),
             (_, .null, .some(true)):
            providerSelectionIsCoherent = false
        default:
            providerSelectionIsCoherent = true
        }
        let modelSelectionIsCoherent: Bool
        switch (providerMode, byokProvider, modelSelection) {
        case (.some(.appDefault), _, .some(let model)):
            modelSelectionIsCoherent = model == .automatic
        case (_, .value(let provider), .some(let model)):
            modelSelectionIsCoherent = model.isCompatible(with: provider)
        default:
            modelSelectionIsCoherent = true
        }
        guard expectedSettingsRevision > 0,
              IdempotencyKeyContract.isValid(idempotencyKey),
              hasChange,
              providerSelectionIsCoherent,
              modelSelectionIsCoherent,
              normalizedTimezone.map({ (1 ... 100).contains($0.utf16.count) }) ?? true,
              normalizedLocale.map(UserSettings.isValidLocale) ?? true else {
            throw DomainValidationError.invalidValue("Settings update violates the API contract")
        }
        self.expectedSettingsRevision = expectedSettingsRevision
        self.idempotencyKey = idempotencyKey
        self.organizationMode = organizationMode
        self.providerMode = providerMode
        self.byokProvider = byokProvider
        self.modelSelection = modelSelection
        self.byokFallbackToApp = byokFallbackToApp
        self.routingEffort = routingEffort
        self.expansionStyle = expansionStyle
        self.timezone = normalizedTimezone
        self.locale = normalizedLocale
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(expectedSettingsRevision, forKey: .expectedSettingsRevision)
        try container.encode(idempotencyKey, forKey: .idempotencyKey)
        try container.encodeIfPresent(organizationMode, forKey: .organizationMode)
        try container.encodeIfPresent(providerMode, forKey: .providerMode)
        try container.encodePatch(byokProvider, forKey: .byokProvider)
        try container.encodeIfPresent(modelSelection, forKey: .modelSelection)
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
        guard lastFour.unicodeScalars.count == 4,
              lastFour.unicodeScalars.allSatisfy({ (0x21 ... 0x7E).contains($0.value) }) else {
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
        guard status != .active || validatedAt != nil else {
            throw DecodingError.dataCorruptedError(
                forKey: .validatedAt,
                in: container,
                debugDescription: "An active provider key must have a validation timestamp"
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
    public let expectedCredentialRevision: Int?
    private let apiKey: String

    private enum CodingKeys: String, CodingKey {
        case idempotencyKey, provider, expectedCredentialRevision, apiKey
    }

    public init(
        idempotencyKey: String,
        provider: AIProvider,
        expectedCredentialRevision: Int?,
        apiKey: String
    ) throws {
        guard IdempotencyKeyContract.isValid(idempotencyKey),
              expectedCredentialRevision.map({ $0 > 0 }) ?? true,
              ProviderKeyInputRules.isValid(apiKey) else {
            throw DomainValidationError.invalidValue("Provider key length is invalid")
        }
        self.idempotencyKey = idempotencyKey
        self.provider = provider
        self.expectedCredentialRevision = expectedCredentialRevision
        self.apiKey = apiKey
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(idempotencyKey, forKey: .idempotencyKey)
        try container.encode(provider, forKey: .provider)
        if let expectedCredentialRevision {
            try container.encode(expectedCredentialRevision, forKey: .expectedCredentialRevision)
        } else {
            try container.encodeNil(forKey: .expectedCredentialRevision)
        }
        try container.encode(apiKey, forKey: .apiKey)
    }
}

enum ProviderKeyInputRules {
    static func isValid(_ value: String) -> Bool {
        (20 ... 500).contains(value.utf16.count) &&
            value.unicodeScalars.allSatisfy { (0x21 ... 0x7E).contains($0.value) }
    }
}

extension ProviderKeyPutRequest: CustomStringConvertible, CustomDebugStringConvertible {
    public var description: String { "ProviderKeyPutRequest(<redacted>)" }
    public var debugDescription: String { description }
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
    public let expectedCredentialRevision: Int

    public init(
        idempotencyKey: String,
        provider: AIProvider,
        expectedCredentialRevision: Int
    ) throws {
        guard IdempotencyKeyContract.isValid(idempotencyKey),
              expectedCredentialRevision > 0 else {
            throw DomainValidationError.invalidValue("Credential revision must be positive")
        }
        self.idempotencyKey = idempotencyKey
        self.provider = provider
        self.expectedCredentialRevision = expectedCredentialRevision
    }
}

public struct ProviderKeyDeleteResponse: Codable, Equatable, Sendable {
    public let provider: AIProvider
    public let deleted: Bool
    public let deletedCredentialRevision: Int
    public let replayed: Bool

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case provider, deleted, deletedCredentialRevision, replayed
    }

    public init(from decoder: Decoder) throws {
        try StrictJSONKey.requireExactKeys(CodingKeys.allCases.map(\.rawValue), from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        provider = try container.decode(AIProvider.self, forKey: .provider)
        deleted = try container.decode(Bool.self, forKey: .deleted)
        deletedCredentialRevision = try container.decode(
            Int.self,
            forKey: .deletedCredentialRevision
        )
        replayed = try container.decode(Bool.self, forKey: .replayed)
        guard deleted, deletedCredentialRevision > 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .deleted,
                in: container,
                debugDescription: "Provider-key deletion response must confirm deletion"
            )
        }
    }
}

/// Editable, non-secret settings state. This value is safe to keep in memory and compare for
/// idempotent retries because provider credentials are intentionally modeled elsewhere.
struct AISettingsDraft: Equatable, Sendable {
    var organizationMode: OrganizationMode
    var providerMode: ProviderMode
    var byokProvider: AIProvider
    var modelSelection: AIModelSelection
    var byokFallbackToApp: Bool
    var routingEffort: RoutingEffort
    var expansionStyle: ExpansionStyle
    var timezone: String
    var locale: String

    init(settings: UserSettings) {
        organizationMode = settings.organizationMode
        providerMode = settings.providerMode
        byokProvider = settings.byokProvider ?? .openai
        modelSelection = settings.modelSelection
        byokFallbackToApp = settings.byokFallbackToApp
        routingEffort = settings.routingEffort
        expansionStyle = settings.expansionStyle
        timezone = settings.timezone
        locale = settings.locale
    }

    var normalizedTimezone: String {
        timezone.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var normalizedLocale: String {
        locale.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// The model `auto` resolves to for the drafted provider and effort.
    var resolvedAutomaticModel: AIModelSelection {
        AIModelRegistry.automaticModel(for: byokProvider, effort: routingEffort)
    }

    /// Returns a draft that follows the chosen access mode. App-default mode has no BYOK provider
    /// choice, so the model returns to Automatic and managed fallback turns off.
    func selectingProviderMode(_ mode: ProviderMode) -> AISettingsDraft {
        var next = self
        next.providerMode = mode
        if mode == .appDefault {
            next.modelSelection = .automatic
            next.byokFallbackToApp = false
        }
        return next
    }

    /// Returns a draft for the chosen provider. An exact model that belongs to the other provider
    /// resets to Automatic; a compatible choice is kept, and no saved key is affected.
    func selectingProvider(_ provider: AIProvider) -> AISettingsDraft {
        var next = self
        next.byokProvider = provider
        if !modelSelection.isCompatible(with: provider) {
            next.modelSelection = .automatic
        }
        return next
    }

    /// Returns a draft whose fallback choice respects the deployment. Unavailable deployments
    /// force fallback off so the draft, the request, and the confirmed snapshot all agree.
    func applyingManagedFallbackAvailability(_ isAvailable: Bool) -> AISettingsDraft {
        var next = self
        next.byokFallbackToApp = ManagedFallbackContract.fallbackValue(
            requested: byokFallbackToApp,
            isAvailable: isAvailable
        )
        return next
    }

    var validationMessage: String? {
        if TimeZone(identifier: normalizedTimezone) == nil {
            return "Enter a valid IANA timezone, such as America/Los_Angeles."
        }
        if !UserSettings.isValidLocale(normalizedLocale) {
            return "Enter a valid locale, such as en-US."
        }
        return nil
    }

    /// Builds the sparse PATCH for this draft. `managedFallbackAvailable` mirrors the deployment
    /// flag: when it is `false` the request can never carry `byokFallbackToApp: true`.
    func makeUpdateRequest(
        comparedTo current: UserSettings,
        idempotencyKey: String,
        managedFallbackAvailable: Bool
    ) throws -> UserSettingsUpdateRequest? {
        guard validationMessage == nil else {
            throw DomainValidationError.invalidValue("Settings contain an invalid timezone or locale")
        }

        let normalizedProvider: AIProvider? = providerMode == .byok ? byokProvider : nil
        let normalizedModel: AIModelSelection = providerMode == .byok ? modelSelection : .automatic
        guard normalizedProvider.map({ normalizedModel.isCompatible(with: $0) }) ?? true else {
            throw DomainValidationError.invalidValue("The selected model does not match the provider")
        }

        let modeChanged = providerMode != current.providerMode
        let providerChanged = normalizedProvider != current.byokProvider
        let requestedProvider: PatchField<AIProvider>
        if providerChanged {
            requestedProvider = normalizedProvider.map(PatchField.value) ?? .null
        } else {
            requestedProvider = .unchanged
        }
        let normalizedFallback = providerMode == .byok
            ? ManagedFallbackContract.fallbackValue(
                requested: byokFallbackToApp,
                isAvailable: managedFallbackAvailable
            )
            : false
        let hasChange = organizationMode != current.organizationMode || modeChanged || providerChanged ||
            normalizedModel != current.modelSelection ||
            normalizedFallback != current.byokFallbackToApp ||
            routingEffort != current.routingEffort ||
            expansionStyle != current.expansionStyle ||
            normalizedTimezone != current.timezone ||
            normalizedLocale != current.locale
        guard hasChange else { return nil }

        return try UserSettingsUpdateRequest(
            expectedSettingsRevision: current.settingsRevision,
            idempotencyKey: idempotencyKey,
            organizationMode: organizationMode == current.organizationMode ? nil : organizationMode,
            providerMode: modeChanged ? providerMode : nil,
            byokProvider: requestedProvider,
            modelSelection: normalizedModel == current.modelSelection ? nil : normalizedModel,
            byokFallbackToApp: normalizedFallback == current.byokFallbackToApp
                ? nil
                : normalizedFallback,
            routingEffort: routingEffort == current.routingEffort ? nil : routingEffort,
            expansionStyle: expansionStyle == current.expansionStyle ? nil : expansionStyle,
            timezone: normalizedTimezone == current.timezone ? nil : normalizedTimezone,
            locale: normalizedLocale == current.locale ? nil : normalizedLocale
        )
    }

    func matches(_ settings: UserSettings) -> Bool {
        settings.organizationMode == organizationMode &&
            settings.providerMode == providerMode &&
            settings.byokProvider == (providerMode == .byok ? byokProvider : nil) &&
            settings.modelSelection == (providerMode == .byok ? modelSelection : .automatic) &&
            settings.byokFallbackToApp == (providerMode == .byok ? byokFallbackToApp : false) &&
            settings.routingEffort == routingEffort &&
            settings.expansionStyle == expansionStyle &&
            settings.timezone == normalizedTimezone &&
            settings.locale == normalizedLocale
    }
}

enum AISettingsRetryContract {
    static func permitsSave(
        hasPendingRetry: Bool,
        pendingDraft: AISettingsDraft?,
        submittedDraft: AISettingsDraft
    ) -> Bool {
        !hasPendingRetry || pendingDraft == submittedDraft
    }

    static func controlsAreLocked(
        isLoading: Bool,
        isSaving: Bool,
        hasPendingRetry: Bool,
        isReconcilingRetry: Bool = false
    ) -> Bool {
        isLoading || isSaving || hasPendingRetry || isReconcilingRetry
    }

    static func reconcile(
        current: UserSettings,
        load: @escaping @Sendable () async throws -> UserSettingsResponse
    ) async -> AISettingsRetryReconciliation {
        do {
            let response = try await load()
            guard response.settings.settingsRevision >= current.settingsRevision else {
                return .unavailable
            }
            return .confirmed(response.settings)
        } catch {
            return .unavailable
        }
    }
}

enum AISettingsRetryReconciliation: Equatable, Sendable {
    case confirmed(UserSettings)
    case unavailable

    var authoritativeSettings: UserSettings? {
        guard case let .confirmed(settings) = self else { return nil }
        return settings
    }

    var retainsRetryLock: Bool {
        authoritativeSettings == nil
    }
}

enum AISettingsMutationContract {
    static func accepts(
        _ response: UserSettingsUpdateResponse,
        replacing current: UserSettings,
        with draft: AISettingsDraft
    ) -> Bool {
        response.settings.settingsRevision == current.settingsRevision + 1 &&
            draft.matches(response.settings)
    }

    static func accepts(
        _ response: ProviderKeyPutResponse,
        provider: AIProvider,
        expectedCredentialRevision: Int?,
        submittedKey: String
    ) -> Bool {
        let revisionMatches = expectedCredentialRevision.map {
            response.providerKey.credentialRevision == $0 + 1
        } ?? (response.providerKey.credentialRevision > 0)
        return response.providerKey.provider == provider &&
            response.providerKey.status == .active &&
            response.providerKey.validatedAt != nil &&
            revisionMatches &&
            response.providerKey.lastFour == String(submittedKey.suffix(4))
    }

    static func accepts(
        _ response: ProviderKeyDeleteResponse,
        provider: AIProvider,
        expectedCredentialRevision: Int
    ) -> Bool {
        response.provider == provider && response.deleted &&
            response.deletedCredentialRevision == expectedCredentialRevision
    }
}
