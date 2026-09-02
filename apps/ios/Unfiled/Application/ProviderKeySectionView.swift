import SwiftUI

/// Credential controls for one provider. OpenAI and Claude each get their own section so both keys
/// can be saved at once and either can be replaced or deleted without touching the other.
///
/// The pasted key lives only in this view's local state until submission, and is cleared the moment
/// validation begins, the scene leaves the foreground, or the screen disappears.
struct ProviderKeySectionView: View {
    let provider: AIProvider
    let metadata: ProviderKeyMetadata?
    let isSelectedForNewCaptures: Bool
    let mutation: ProviderKeyMutation?
    let isLocked: Bool
    let pendingRetryProvider: AIProvider?
    let errorMessage: String?
    let onSave: @MainActor (String, AIProvider) async -> Bool
    let onDiscardRetry: @MainActor () -> Void
    let onRequestDelete: @MainActor (AIProvider) -> Void

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var input = ""
    @FocusState private var isInputFocused: Bool

    var body: some View {
        SettingsSection("\(provider.displayName) key") {
            Text(introCopy)
                .settingsSupportingText()
            statusCard
            credentialForm
            actions
                .padding(.top, AISettingsControlLayout.credentialFieldActionGap)
        }
        .accessibilityIdentifier(scoped(AISettingsAccessibilityIdentifier.keySection))
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { clearInput() }
        }
        .onDisappear { clearInput() }
    }

    // MARK: Status

    private var statusCard: some View {
        HStack(alignment: .top, spacing: 13) {
            statusIcon
                .frame(width: 24, height: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(statusTitle)
                    .font(.system(.subheadline, weight: .semibold))
                if let metadata {
                    Text("•••• \(metadata.lastFour) · revision \(metadata.credentialRevision)")
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(UnfiledTheme.fog)
                    if let validatedAt = metadata.validatedAt {
                        Text("Validated \(validatedAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.system(.caption))
                            .foregroundStyle(UnfiledTheme.fog)
                    }
                } else {
                    Text(emptyStatusDetail)
                        .font(.system(.caption))
                        .foregroundStyle(UnfiledTheme.fog)
                }
                if isSelectedForNewCaptures {
                    Text("Selected for new captures")
                        .font(.system(.caption, weight: .semibold))
                        .foregroundStyle(UnfiledTheme.persimmon)
                }
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 6)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(UnfiledTheme.raised)
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(scoped(AISettingsAccessibilityIdentifier.keyStatus))
    }

    @ViewBuilder
    private var statusIcon: some View {
        if isMutating {
            ProgressView()
                .tint(UnfiledTheme.paper)
        } else {
            Image(systemName: statusSymbol)
                .font(.system(.body, weight: .semibold))
                .foregroundStyle(statusColor)
        }
    }

    // MARK: Form

    private var credentialForm: some View {
        VStack(alignment: .leading, spacing: AISettingsControlLayout.fieldHelpSpacing) {
            SettingsLabeledField(fieldLabel) {
                SecureField("Paste key", text: $input)
                    .textContentType(nil)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .submitLabel(.done)
                    .focused($isInputFocused)
                    .privacySensitive()
                    .disabled(isInputDisabled)
                    .accessibilityLabel(fieldLabel)
                    .accessibilityHint("Cleared from this screen as soon as validation begins")
                    .accessibilityIdentifier(scoped(AISettingsAccessibilityIdentifier.keyInput))
                    .onSubmit(save)
            }
            Text("Sent once for validation and Vault storage. It is never returned, and never saved in app preferences, drafts, analytics, or the on-device database.")
                .settingsSupportingText()
            if let errorMessage {
                SettingsInlineMessage(
                    message: errorMessage,
                    kind: .error,
                    accessibilityIdentifier: scoped(AISettingsAccessibilityIdentifier.keyError)
                )
            }
            if let blockedCopy {
                SettingsInlineMessage(message: blockedCopy, kind: .warning)
            }
        }
    }

    // MARK: Actions

    private var actions: some View {
        SettingsActionRow(
            stacksVertically: dynamicTypeSize.isAccessibilitySize || !hasSecondaryAction
        ) { fillsWidth in
            secondaryAction(fillsWidth: fillsWidth)
        } primary: {
            SettingsPrimaryButton(
                title: primaryTitle,
                loadingTitle: mutationTitle,
                isLoading: isMutating,
                isDisabled: !canSubmit,
                systemImage: hasPendingRetry ? "arrow.clockwise" : "arrow.right",
                accessibilityIdentifier: scoped(AISettingsAccessibilityIdentifier.keySave),
                action: save
            )
            .accessibilityHint(primaryHint)
        }
    }

    @ViewBuilder
    private func secondaryAction(fillsWidth: Bool) -> some View {
        if hasPendingRetry {
            SettingsSecondaryButton(
                title: "Start over",
                role: .neutral,
                isDisabled: isLocked,
                fillsWidth: fillsWidth,
                accessibilityHint: "Discards only the retry coordinates, never a stored key",
                accessibilityIdentifier: scoped(AISettingsAccessibilityIdentifier.keyRetryDiscard)
            ) {
                clearInput()
                onDiscardRetry()
            }
        } else if metadata != nil {
            SettingsSecondaryButton(
                title: "Delete key",
                role: .destructive,
                isDisabled: isLocked || isBlockedByOtherRetry,
                fillsWidth: fillsWidth,
                accessibilityHint: "Permanently destroys the protected \(provider.displayName) key after confirmation",
                accessibilityIdentifier: scoped(AISettingsAccessibilityIdentifier.keyDelete)
            ) {
                clearInput()
                onRequestDelete(provider)
            }
        }
    }

    // MARK: Derived state

    private var isMutating: Bool { mutation?.provider == provider }
    private var hasPendingRetry: Bool { pendingRetryProvider == provider }
    private var isBlockedByOtherRetry: Bool {
        pendingRetryProvider != nil && pendingRetryProvider != provider
    }

    private var hasSecondaryAction: Bool { hasPendingRetry || metadata != nil }
    private var isInputDisabled: Bool { isLocked || isBlockedByOtherRetry }
    private var canSubmit: Bool {
        ProviderKeyInputRules.isValid(input) && !isLocked && !isBlockedByOtherRetry
    }

    private var statusTitle: String {
        if let mutation, mutation.provider == provider {
            return mutation.action == .delete
                ? "Deleting \(provider.displayName) key…"
                : "Validating \(provider.displayName) key…"
        }
        if hasPendingRetry { return "Save result unknown" }
        return AISettingsCopy.keyStatusTitle(metadata?.status)
    }

    private var statusSymbol: String {
        switch metadata?.status {
        case .active: "checkmark.shield.fill"
        case .invalid, .revoked: "exclamationmark.shield.fill"
        case nil: "key.fill"
        }
    }

    private var statusColor: Color {
        switch metadata?.status {
        case .active: UnfiledTheme.paper
        case .invalid, .revoked: UnfiledTheme.persimmon
        case nil: UnfiledTheme.fog
        }
    }

    private var emptyStatusDetail: String {
        hasPendingRetry
            ? "The last save was not confirmed. Paste the exact same key to reconcile it, or start over."
            : "Paste a key below to make \(provider.displayName) available to new captures."
    }

    private var introCopy: String {
        let other = provider == .openai ? AIProvider.anthropic : AIProvider.openai
        return "Validated with \(provider.displayName), then stored in Supabase Vault. Kept alongside any \(other.displayName) key."
    }

    private var fieldLabel: String {
        let name = provider.displayName
        if hasPendingRetry { return "Paste the same \(name) API key" }
        return metadata == nil ? "\(name) API key" : "Replacement \(name) API key"
    }

    private var primaryTitle: String {
        if hasPendingRetry { return "Retry same key" }
        return metadata == nil ? "Validate and save" : "Validate replacement"
    }

    private var mutationTitle: String {
        mutation?.action == .delete ? "Deleting…" : "Validating…"
    }

    private var primaryHint: String {
        hasPendingRetry
            ? "Retries the unchanged request with the same action key"
            : "Sends the key once for validation, then stores only its metadata"
    }

    private var blockedCopy: String? {
        guard isBlockedByOtherRetry, let pendingRetryProvider else { return nil }
        return "Finish or discard the pending \(pendingRetryProvider.displayName) key retry before changing this key."
    }

    // MARK: Behavior

    private func save() {
        guard canSubmit else { return }
        let submittedKey = input
        let submittedProvider = provider
        clearInput()
        Task { @MainActor in _ = await onSave(submittedKey, submittedProvider) }
    }

    private func clearInput() {
        isInputFocused = false
        input.removeAll(keepingCapacity: false)
    }

    private func scoped(_ identifier: String) -> String {
        AISettingsAccessibilityIdentifier.scoped(identifier, provider)
    }
}
