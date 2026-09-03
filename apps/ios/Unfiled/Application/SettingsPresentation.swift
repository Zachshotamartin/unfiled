import Foundation

/// The pages Settings pushes. Anything with more than three choices, or free text, gets a page
/// instead of inline controls, so the main screen stays a short list of rows.
enum SettingsPage: Hashable, Identifiable {
    case access, effort, model, expansion, behavior, dayBoundary

    var id: Self { self }
}

/// Values shown on the right of the Organization rows, and the one-line details on their pages.
enum SettingsRowPresentation {
    static func accessValue(_ draft: AISettingsDraft) -> String {
        AISettingsCopy.accessTitle(draft.providerMode)
    }

    static func effortValue(_ draft: AISettingsDraft) -> String {
        AISettingsCopy.routingTitle(draft.routingEffort)
    }

    /// Managed access always runs the automatic model, so the row never shows a stale exact pick.
    static func modelValue(_ draft: AISettingsDraft) -> String {
        let model: AIModelSelection = draft.providerMode == .byok ? draft.modelSelection : .automatic
        return AIModelRegistry.label(for: model)
    }

    static func expansionValue(_ draft: AISettingsDraft) -> String {
        AISettingsCopy.expansionTitle(draft.expansionStyle)
    }

    static func behaviorValue(_ draft: AISettingsDraft) -> String {
        AISettingsCopy.organizationTitle(draft.organizationMode)
    }

    static func timezoneValue(_ draft: AISettingsDraft) -> String {
        draft.normalizedTimezone
    }

    static func modelDetail(_ model: AIModelSelection, draft: AISettingsDraft) -> String {
        if model == .automatic {
            return "Follows effort · now \(AIModelRegistry.label(for: draft.resolvedAutomaticModel))"
        }
        let base = AIModelRegistry.detail(for: model)
        return AIModelRegistry.isHigherCost(model) ? "\(base) Higher cost on your key." : base
    }
}

/// Copy and decisions for the AI key group, kept pure so the rules are testable without a view.
enum ProviderKeyGroupPresentation {
    /// The one caption line above the key field, or nothing when the saved state needs no note.
    static func caption(
        mode: ProviderMode?,
        isManagedFallbackAvailable: Bool,
        provider: AIProvider,
        keyStatus: ProviderKeyStatus?,
        fallbackAllowed: Bool
    ) -> String? {
        switch mode {
        case .appDefault where !isManagedFallbackAvailable:
            return "This free beta does not fund AI. Add your own OpenAI or Claude key to organize new captures."
        case .byok where keyStatus != .active && !fallbackAllowed:
            return "No active \(provider.displayName) key is saved. New captures wait in the queue until one is."
        case .appDefault, .byok, nil:
            return nil
        }
    }

    /// Tapping a provider chip switches new captures to it right away only when that provider
    /// already has an active key; otherwise the chip just aims the key field at the provider.
    static func selectsProviderImmediately(keyStatus: ProviderKeyStatus?) -> Bool {
        keyStatus == .active
    }

    /// The draft to save once a key is validated: My API key mode on the key's provider, so the
    /// user never chooses a mode separately. Goes through the same settings update contract.
    static func draftUsingKey(_ draft: AISettingsDraft, for provider: AIProvider) -> AISettingsDraft {
        draft.selectingProviderMode(.byok).selectingProvider(provider)
    }

    /// One line per saved key: the last four and the validation date, never the revision. An
    /// active key reads quietly; a rejected or revoked one names its state first.
    static func statusLine(_ metadata: ProviderKeyMetadata) -> String {
        switch metadata.status {
        case .active:
            let validated = metadata.validatedAt
                .map { $0.formatted(date: .abbreviated, time: .omitted) } ?? "Active"
            return "Ends \(metadata.lastFour) · \(validated)"
        case .invalid:
            return "Rejected · ends \(metadata.lastFour)"
        case .revoked:
            return "Revoked · ends \(metadata.lastFour)"
        }
    }
}
