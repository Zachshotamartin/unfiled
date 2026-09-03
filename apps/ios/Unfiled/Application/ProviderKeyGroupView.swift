import SwiftUI

/// The AI key group: which provider, one masked field with Save, and a status row per saved key.
/// Both keys can be saved at once; the chips only choose which one the field is for.
///
/// The pasted key lives only in this view's local state until submission, and is cleared the moment
/// validation begins, the scene leaves the foreground, or the screen disappears.
struct ProviderKeyGroupView: View {
    let selectedProvider: AIProvider
    let providerInUse: AIProvider?
    let providerKeys: [AIProvider: ProviderKeyMetadata]
    let caption: String?
    let mutation: ProviderKeyMutation?
    let isLocked: Bool
    let pendingRetryProvider: AIProvider?
    let errors: [AIProvider: String]
    let onSelectProvider: @MainActor (AIProvider) -> Void
    let onSave: @MainActor (String, AIProvider) async -> Bool
    let onDiscardRetry: @MainActor () -> Void
    let onRequestDelete: @MainActor (AIProvider) -> Void

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var input = ""
    @FocusState private var isInputFocused: Bool

    var body: some View {
        SettingsGroup(label: "AI key") {
            credentialBlock
            ForEach(AIProvider.allCases, id: \.self) { provider in
                if let metadata = providerKeys[provider] {
                    ProviderKeyStatusRow(
                        provider: provider,
                        metadata: metadata,
                        isInUse: providerInUse == provider,
                        mutation: mutation,
                        isRemoveDisabled: isLocked || pendingRetryProvider != nil
                    ) {
                        clearInput()
                        onRequestDelete(provider)
                    }
                }
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { clearInput() }
        }
        .onChange(of: selectedProvider) { _, _ in clearInput() }
        .onDisappear { clearInput() }
    }

    // MARK: Credential entry

    private var credentialBlock: some View {
        VStack(alignment: .leading, spacing: AISettingsControlLayout.sectionContentSpacing) {
            providerChips
            if let caption {
                Text(caption)
                    .settingsSupportingText()
            }
            credentialField
            Text("Sent once for validation, then kept in protected server storage. Never saved on this phone.")
                .settingsSupportingText()
            if let errorMessage = errors[selectedProvider] {
                SettingsInlineMessage(
                    message: errorMessage,
                    kind: .error,
                    accessibilityIdentifier: scoped(AISettingsAccessibilityIdentifier.keyError)
                )
            }
            if let blockedCopy {
                SettingsInlineMessage(message: blockedCopy, kind: .warning)
            }
            if hasPendingRetry {
                SettingsSecondaryButton(
                    title: "Start over",
                    role: .neutral,
                    isDisabled: isLocked,
                    fillsWidth: true,
                    accessibilityHint: "Discards only the retry coordinates, never a stored key",
                    accessibilityIdentifier: scoped(AISettingsAccessibilityIdentifier.keyRetryDiscard)
                ) {
                    clearInput()
                    onDiscardRetry()
                }
            }
        }
        .settingsBlock()
        .accessibilityIdentifier(scoped(AISettingsAccessibilityIdentifier.keySection))
    }

    private var providerChips: some View {
        HStack(spacing: UnfiledTheme.controlGap) {
            ForEach(AIProvider.allCases, id: \.self) { provider in
                Chip(title: provider.displayName, selected: selectedProvider == provider) {
                    onSelectProvider(provider)
                }
                .accessibilityLabel("\(provider.displayName) key")
                .accessibilityHint(chipHint(provider))
            }
        }
        .disabled(isLocked)
        .accessibilityIdentifier(AISettingsAccessibilityIdentifier.provider)
    }

    /// The field and Save share a line; accessibility text sizes stack them so neither is squeezed.
    @ViewBuilder
    private var credentialField: some View {
        if dynamicTypeSize.isAccessibilitySize {
            VStack(spacing: UnfiledTheme.controlGap) {
                secureField
                saveButton
            }
        } else {
            HStack(spacing: UnfiledTheme.controlGap) {
                secureField
                saveButton
            }
        }
    }

    private var secureField: some View {
        SecureField(placeholder, text: $input)
            .textContentType(nil)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .keyboardType(.asciiCapable)
            .submitLabel(.done)
            .focused($isInputFocused)
            .privacySensitive()
            .disabled(isInputDisabled)
            .padding(.horizontal, UnfiledTheme.fieldPadding)
            .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
            .background(UnfiledTheme.graphite)
            .overlay {
                RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                    .stroke(UnfiledTheme.border)
            }
            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            .accessibilityLabel(fieldLabel)
            .accessibilityHint("Cleared from this screen as soon as validation begins")
            .accessibilityIdentifier(scoped(AISettingsAccessibilityIdentifier.keyInput))
            .onSubmit(save)
    }

    private var saveButton: some View {
        SettingsInlinePrimaryButton(
            title: hasPendingRetry ? "Retry" : "Save",
            isLoading: isSaving,
            isDisabled: !canSubmit,
            accessibilityLabel: saveAccessibilityLabel,
            accessibilityHint: saveHint,
            accessibilityIdentifier: scoped(AISettingsAccessibilityIdentifier.keySave),
            action: save
        )
        .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? .infinity : nil)
    }

    // MARK: Derived state

    private var isSaving: Bool {
        mutation?.provider == selectedProvider && mutation?.action == .save
    }

    private var hasPendingRetry: Bool { pendingRetryProvider == selectedProvider }

    private var isBlockedByOtherRetry: Bool {
        pendingRetryProvider != nil && pendingRetryProvider != selectedProvider
    }

    private var isInputDisabled: Bool { isLocked || isBlockedByOtherRetry }

    private var canSubmit: Bool {
        ProviderKeyInputRules.isValid(input) && !isLocked && !isBlockedByOtherRetry
    }

    private var placeholder: String {
        let name = selectedProvider.displayName
        if hasPendingRetry { return "Paste the same \(name) key" }
        return providerKeys[selectedProvider] == nil
            ? "Paste your \(name) key"
            : "Paste a new \(name) key"
    }

    private var fieldLabel: String {
        let name = selectedProvider.displayName
        if hasPendingRetry { return "Paste the same \(name) API key" }
        return providerKeys[selectedProvider] == nil
            ? "\(name) API key"
            : "Replacement \(name) API key"
    }

    private var saveAccessibilityLabel: String {
        let name = selectedProvider.displayName
        if hasPendingRetry { return "Retry saving the same \(name) key" }
        return providerKeys[selectedProvider] == nil
            ? "Validate and save \(name) key"
            : "Validate replacement \(name) key"
    }

    private var saveHint: String {
        hasPendingRetry
            ? "Retries the unchanged request with the same action key"
            : "Sends the key once for validation, then stores only its metadata"
    }

    private var blockedCopy: String? {
        guard isBlockedByOtherRetry, let pendingRetryProvider else { return nil }
        return "Finish or discard the pending \(pendingRetryProvider.displayName) key retry before changing this key."
    }

    private func chipHint(_ provider: AIProvider) -> String {
        providerKeys[provider]?.status == .active
            ? "Uses the saved \(provider.displayName) key for new captures"
            : "Aims the key field at \(provider.displayName)"
    }

    // MARK: Behavior

    private func save() {
        guard canSubmit else { return }
        let submittedKey = input
        let submittedProvider = selectedProvider
        clearInput()
        Task { @MainActor in _ = await onSave(submittedKey, submittedProvider) }
    }

    private func clearInput() {
        isInputFocused = false
        input.removeAll(keepingCapacity: false)
    }

    private func scoped(_ identifier: String) -> String {
        AISettingsAccessibilityIdentifier.scoped(identifier, selectedProvider)
    }
}

/// One saved key on one line: the provider, the last four and validation date, and Remove.
/// A dot marks the key new captures use. Wide type sizes fall back to two lines.
private struct ProviderKeyStatusRow: View {
    let provider: AIProvider
    let metadata: ProviderKeyMetadata
    let isInUse: Bool
    let mutation: ProviderKeyMutation?
    let isRemoveDisabled: Bool
    let onRemove: @MainActor () -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .center, spacing: AISettingsControlLayout.rowValueSpacing) {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    name
                    detail
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                trailing
            }
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .center) {
                    name
                    Spacer(minLength: 8)
                    trailing
                }
                detail
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .settingsRow()
    }

    private var name: some View {
        HStack(alignment: .center, spacing: 8) {
            if isInUse {
                StatusDot(color: UnfiledTheme.persimmon)
            }
            Text(provider.displayName)
                .font(UnfiledType.body)
                .foregroundStyle(UnfiledTheme.paper)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(isInUse ? "\(provider.displayName), used for new captures" : provider.displayName)
    }

    private var detail: some View {
        Text(detailText)
            .font(UnfiledType.secondary)
            .foregroundStyle(metadata.status == .active ? UnfiledTheme.fog : UnfiledTheme.persimmon)
            .accessibilityIdentifier(
                AISettingsAccessibilityIdentifier.scoped(AISettingsAccessibilityIdentifier.keyStatus, provider)
            )
    }

    @ViewBuilder
    private var trailing: some View {
        if mutation?.provider == provider {
            ProgressView()
                .tint(UnfiledTheme.paper)
                .accessibilityLabel(mutationTitle)
        } else {
            Button("Remove", role: .destructive, action: onRemove)
                .font(UnfiledType.secondaryStrong)
                .foregroundStyle(UnfiledTheme.persimmon)
                .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                .buttonStyle(.plain)
                .disabled(isRemoveDisabled)
                .opacity(isRemoveDisabled ? 0.55 : 1)
                .accessibilityLabel("Remove \(provider.displayName) key")
                .accessibilityHint("Permanently destroys the protected \(provider.displayName) key after confirmation")
                .accessibilityIdentifier(
                    AISettingsAccessibilityIdentifier.scoped(AISettingsAccessibilityIdentifier.keyDelete, provider)
                )
        }
    }

    private var detailText: String {
        mutation?.provider == provider
            ? mutationTitle
            : ProviderKeyGroupPresentation.statusLine(metadata)
    }

    private var mutationTitle: String {
        mutation?.action == .delete ? "Removing…" : "Validating…"
    }
}
