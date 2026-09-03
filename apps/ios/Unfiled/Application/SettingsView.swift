import SwiftUI

struct SettingsView: View {
    let email: String
    let apiHost: String
    let aiSettings: UserSettings?
    let providerKeys: [AIProvider: ProviderKeyMetadata]
    let isManagedFallbackAvailable: Bool
    let isLoadingAISettings: Bool
    let hasLoadedAISettings: Bool
    let isSavingAISettings: Bool
    let hasPendingAISettingsRetry: Bool
    let providerKeyMutation: ProviderKeyMutation?
    let pendingProviderKeyRetry: AIProvider?
    let aiSettingsError: String?
    let providerKeyErrors: [AIProvider: String]
    let accountExportArtifact: AccountExportArtifact?
    let isPreparingAccountExport: Bool
    let accountExportError: String?
    let isDeletingAccount: Bool
    let hasPendingAccountDeletionReplay: Bool
    let accountDeletionError: String?
    let onRefreshAISettings: @MainActor () async -> Void
    let onSaveAISettings: @MainActor (AISettingsDraft) async -> Bool
    let onDiscardAISettingsRetry: @MainActor () async -> UserSettings?
    let onSaveProviderKey: @MainActor (String, AIProvider) async -> Bool
    let onDiscardProviderKeyRetry: @MainActor () -> Void
    let onDeleteProviderKey: @MainActor (AIProvider) async -> Bool
    let onPrepareAccountExport: @MainActor () async -> Void
    let onDiscardAccountExport: @MainActor (AccountExportArtifact) -> Void
    let onDeleteAccount: @MainActor () async -> Bool
    let onOpenRoutingRules: @MainActor () -> Void
    let onSignOut: @MainActor () async -> Void

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @State private var draft: AISettingsDraft?
    @State private var keyProvider: AIProvider = .openai
    @State private var pushedPage: SettingsPage?
    @State private var providerPendingDeletion: AIProvider?
    @State private var confirmsSignOut = false
    @State private var isSigningOut = false
    @State private var isReconcilingAISettingsRetry = false

    /// Top to bottom: the key that makes organization work, how it organizes, automatic filing,
    /// the account, and this phone. Each group is a short list of rows; choices live on pages.
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ScreenHeader(title: "Settings", showsMark: false)

                if isLoadingAISettings, aiSettings == nil {
                    loadingState
                        .padding(.top, UnfiledTheme.sectionTop)
                } else {
                    if hasLoadedAISettings {
                        aiKeyGroup
                            .padding(.top, UnfiledTheme.sectionTop)
                    }
                    if aiSettings != nil, let draft {
                        organizationGroup(draft)
                            .padding(.top, UnfiledTheme.sectionTop)
                    } else if hasLoadedAISettings {
                        settingsUnavailableState
                            .padding(.top, UnfiledTheme.sectionTop)
                    }
                }

                automaticFilingGroup
                    .padding(.top, UnfiledTheme.sectionTop)
                accountGroup
                    .padding(.top, UnfiledTheme.sectionTop)
                phoneGroup
                    .padding(.top, UnfiledTheme.sectionTop)
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, UnfiledTheme.pushedScreenBottom)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await onRefreshAISettings() }
        .navigationDestination(item: $pushedPage) { page in
            destination(page)
        }
        .confirmationDialog(
            Text("Delete the saved \(providerPendingDeletion?.displayName ?? "provider") key?"),
            isPresented: deletionDialogIsPresented,
            titleVisibility: .visible,
            presenting: providerPendingDeletion
        ) { provider in
            Button("Delete \(provider.displayName) key", role: .destructive) {
                Task { @MainActor in _ = await onDeleteProviderKey(provider) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { provider in
            Text("The protected \(provider.displayName) secret is destroyed immediately. Provider requests that already began cannot be recalled. Any other saved key is untouched.")
        }
        .confirmationDialog(
            "Sign out on this iPhone?",
            isPresented: $confirmsSignOut,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive) { signOut() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Pending captures remain encrypted and account-scoped on this device until you sign in again.")
        }
        .task {
            await onRefreshAISettings()
            adopt(aiSettings)
        }
        .onChange(of: aiSettings) { _, value in adopt(value) }
        .onChange(of: isSavingAISettings) { wasSaving, isSaving in
            // Every save ends by re-reading the authoritative copy, so a failed change reverts
            // and a stale-revision refresh wins. An unconfirmed save keeps its locked draft.
            if wasSaving, !isSaving, !hasPendingAISettingsRetry {
                adopt(aiSettings)
            }
        }
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier(AISettingsAccessibilityIdentifier.screen)
        .unfiledScreen()
    }

    // MARK: Load states

    private var loadingState: some View {
        HStack(spacing: 12) {
            UnfiledLoadingView(size: 18)
            Text("Loading protected AI settings…")
                .font(UnfiledType.secondary)
                .foregroundStyle(UnfiledTheme.fog)
        }
        .frame(maxWidth: .infinity, minHeight: 150, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(AISettingsAccessibilityIdentifier.loading)
    }

    private var settingsUnavailableState: some View {
        SettingsGroup(label: "Organization") {
            VStack(alignment: .leading, spacing: AISettingsControlLayout.sectionContentSpacing) {
                SettingsInlineMessage(
                    message: aiSettingsError ?? "AI settings could not be loaded.",
                    kind: .error,
                    accessibilityIdentifier: AISettingsAccessibilityIdentifier.settingsError
                )
                Button("Try again") {
                    Task { @MainActor in await onRefreshAISettings() }
                }
                .font(UnfiledType.secondaryStrong)
                .foregroundStyle(UnfiledTheme.persimmon)
                .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                .accessibilityHint("Reloads AI settings and key status")
            }
            .settingsBlock()
        }
    }

    // MARK: AI key

    private var aiKeyGroup: some View {
        ProviderKeyGroupView(
            selectedProvider: keyProvider,
            providerInUse: selectedProviderForNewCaptures,
            providerKeys: providerKeys,
            caption: keyCaption,
            mutation: providerKeyMutation,
            isLocked: isBusy,
            pendingRetryProvider: pendingProviderKeyRetry,
            errors: providerKeyErrors,
            onSelectProvider: selectKeyProvider,
            onSave: saveProviderKey,
            onDiscardRetry: onDiscardProviderKeyRetry,
            onRequestDelete: { providerPendingDeletion = $0 }
        )
    }

    private var keyCaption: String? {
        let provider = draft?.byokProvider ?? keyProvider
        return ProviderKeyGroupPresentation.caption(
            mode: draft?.providerMode ?? aiSettings?.providerMode,
            isManagedFallbackAvailable: isManagedFallbackAvailable,
            provider: provider,
            keyStatus: providerKeys[provider]?.status,
            fallbackAllowed: draft?.byokFallbackToApp ?? false
        )
    }

    /// A chip aims the field at a provider; with an active key it also switches new captures to it.
    private func selectKeyProvider(_ provider: AIProvider) {
        keyProvider = provider
        guard ProviderKeyGroupPresentation.selectsProviderImmediately(
            keyStatus: providerKeys[provider]?.status
        ) else { return }
        apply { ProviderKeyGroupPresentation.draftUsingKey($0, for: provider) }
    }

    /// A validated key selects My API key mode for its provider through the settings contract,
    /// so the user never picks a mode separately.
    private func saveProviderKey(_ key: String, provider: AIProvider) async -> Bool {
        let saved = await onSaveProviderKey(key, provider)
        if saved {
            apply { ProviderKeyGroupPresentation.draftUsingKey($0, for: provider) }
        }
        return saved
    }

    // MARK: Organization

    private func organizationGroup(_ draft: AISettingsDraft) -> some View {
        SettingsGroup(label: "Organization") {
            if aiSettingsError != nil || hasPendingAISettingsRetry {
                settingsStatus
                    .settingsBlock()
            }
            if isManagedFallbackAvailable {
                SettingsNavigationRow(
                    title: "AI access",
                    value: SettingsRowPresentation.accessValue(draft),
                    accessibilityIdentifier: AISettingsAccessibilityIdentifier.row(
                        AISettingsAccessibilityIdentifier.providerMode
                    )
                ) {
                    pushedPage = .access
                }
            }
            SettingsNavigationRow(
                title: "Effort",
                value: SettingsRowPresentation.effortValue(draft),
                accessibilityIdentifier: AISettingsAccessibilityIdentifier.row(
                    AISettingsAccessibilityIdentifier.routingEffort
                )
            ) {
                pushedPage = .effort
            }
            if draft.providerMode == .byok {
                SettingsNavigationRow(
                    title: "Model",
                    value: SettingsRowPresentation.modelValue(draft),
                    accessibilityIdentifier: AISettingsAccessibilityIdentifier.row(
                        AISettingsAccessibilityIdentifier.model
                    )
                ) {
                    pushedPage = .model
                }
            }
            SettingsNavigationRow(
                title: "Expansion",
                value: SettingsRowPresentation.expansionValue(draft),
                accessibilityIdentifier: AISettingsAccessibilityIdentifier.row(
                    AISettingsAccessibilityIdentifier.expansionStyle
                )
            ) {
                pushedPage = .expansion
            }
            SettingsNavigationRow(
                title: "Behavior",
                value: SettingsRowPresentation.behaviorValue(draft),
                accessibilityIdentifier: AISettingsAccessibilityIdentifier.row(
                    AISettingsAccessibilityIdentifier.organizationMode
                )
            ) {
                pushedPage = .behavior
            }
            SettingsNavigationRow(
                title: "Timezone",
                value: SettingsRowPresentation.timezoneValue(draft),
                accessibilityIdentifier: AISettingsAccessibilityIdentifier.row(
                    AISettingsAccessibilityIdentifier.timezone
                )
            ) {
                pushedPage = .dayBoundary
            }
        }
    }

    /// The save error and, after an unconfirmed save, the two ways out. Shown on the main
    /// screen and repeated at the foot of a page so a failure is seen where it happened.
    private var settingsStatus: some View {
        VStack(alignment: .leading, spacing: AISettingsControlLayout.credentialActionSpacing) {
            if let aiSettingsError {
                SettingsInlineMessage(
                    message: aiSettingsError,
                    kind: .error,
                    accessibilityIdentifier: AISettingsAccessibilityIdentifier.settingsError
                )
            }
            if hasPendingAISettingsRetry {
                SettingsRetryBanner(
                    isRetrying: isSavingAISettings,
                    isReconciling: isReconcilingAISettingsRetry,
                    isBusy: isBusy,
                    stacksVertically: dynamicTypeSize.isAccessibilitySize,
                    onDiscard: reconcileAndDiscardSettingsRetry,
                    onRetry: retrySettingsDraft
                )
            }
        }
    }

    @ViewBuilder
    private var pageStatus: some View {
        if aiSettingsError != nil || hasPendingAISettingsRetry {
            settingsStatus
                .padding(.top, UnfiledTheme.sectionTop)
        }
    }

    // MARK: Pushed pages

    @ViewBuilder
    private func destination(_ page: SettingsPage) -> some View {
        if let draft {
            switch page {
            case .access:
                SettingsChoicePage(
                    title: "AI access",
                    intro: AISettingsCopy.accessIntro,
                    options: accessOptions,
                    selection: draft.providerMode,
                    isLocked: isAISettingsDraftLocked,
                    accessibilityIdentifier: AISettingsAccessibilityIdentifier.providerMode,
                    onSelect: { mode in apply { $0.selectingProviderMode(mode) } },
                    footer: { pageStatus }
                )
            case .effort:
                SettingsChoicePage(
                    title: "Effort",
                    intro: AISettingsCopy.effortIntro,
                    options: RoutingEffort.allCases.map { effort in
                        SettingsChoiceOption(
                            value: effort,
                            title: AISettingsCopy.routingTitle(effort),
                            detail: AISettingsCopy.routingDetail(effort)
                        )
                    },
                    selection: draft.routingEffort,
                    isLocked: isAISettingsDraftLocked,
                    accessibilityIdentifier: AISettingsAccessibilityIdentifier.routingEffort,
                    onSelect: { effort in apply(\.routingEffort, effort) },
                    footer: { pageStatus }
                )
            case .model:
                SettingsChoicePage(
                    title: "Model",
                    intro: AISettingsCopy.modelIntro,
                    options: AIModelRegistry.selections(for: draft.byokProvider).map { model in
                        SettingsChoiceOption(
                            value: model,
                            title: AIModelRegistry.label(for: model),
                            detail: SettingsRowPresentation.modelDetail(model, draft: draft)
                        )
                    },
                    selection: draft.modelSelection,
                    isLocked: isAISettingsDraftLocked,
                    accessibilityIdentifier: AISettingsAccessibilityIdentifier.model,
                    onSelect: { model in apply(\.modelSelection, model) },
                    footer: {
                        fallbackToggle
                        pageStatus
                    }
                )
            case .expansion:
                SettingsChoicePage(
                    title: "Expansion",
                    intro: AISettingsCopy.expansionIntro,
                    options: ExpansionStyle.allCases.map { style in
                        SettingsChoiceOption(
                            value: style,
                            title: AISettingsCopy.expansionTitle(style),
                            detail: AISettingsCopy.expansionDetail(style)
                        )
                    },
                    selection: draft.expansionStyle,
                    isLocked: isAISettingsDraftLocked,
                    accessibilityIdentifier: AISettingsAccessibilityIdentifier.expansionStyle,
                    onSelect: { style in apply(\.expansionStyle, style) },
                    footer: { pageStatus }
                )
            case .behavior:
                SettingsChoicePage(
                    title: "Behavior",
                    intro: AISettingsCopy.behaviorIntro,
                    options: OrganizationMode.allCases.map { mode in
                        SettingsChoiceOption(
                            value: mode,
                            title: AISettingsCopy.organizationTitle(mode),
                            detail: AISettingsCopy.organizationDetail(mode)
                        )
                    },
                    selection: draft.organizationMode,
                    isLocked: isAISettingsDraftLocked,
                    accessibilityIdentifier: AISettingsAccessibilityIdentifier.organizationMode,
                    onSelect: { mode in apply(\.organizationMode, mode) },
                    footer: { pageStatus }
                )
            case .dayBoundary:
                SettingsDayBoundaryPage(
                    draft: draft,
                    isLocked: isAISettingsDraftLocked,
                    isSaving: isSavingAISettings,
                    hasPendingRetry: hasPendingAISettingsRetry,
                    onSave: { candidate in apply { _ in candidate } },
                    footer: { pageStatus }
                )
            }
        } else {
            ScrollView {
                settingsUnavailableState
                    .padding(.horizontal, UnfiledTheme.screenPadding)
                    .padding(.top, UnfiledTheme.pushedHeaderTop)
            }
            .navigationBarTitleDisplayMode(.inline)
            .unfiledScreen()
        }
    }

    /// Managed access is offered as a choice only where the deployment funds it or the account
    /// already saved it, exactly as `ManagedFallbackContract` says.
    private var accessOptions: [SettingsChoiceOption<ProviderMode>] {
        let modes: [ProviderMode] = offersManagedMode ? [.byok, .appDefault] : [.byok]
        return modes.map { mode in
            SettingsChoiceOption(
                value: mode,
                title: AISettingsCopy.accessTitle(mode),
                detail: AISettingsCopy.accessDetail(mode)
            )
        }
    }

    private var offersManagedMode: Bool {
        ManagedFallbackContract.offersManagedMode(
            isAvailable: isManagedFallbackAvailable,
            savedMode: aiSettings?.providerMode ?? .byok
        )
    }

    @ViewBuilder
    private var fallbackToggle: some View {
        if ManagedFallbackContract.showsFallbackToggle(isAvailable: isManagedFallbackAvailable) {
            Toggle(isOn: fallbackBinding) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Allow managed fallback when available")
                        .font(UnfiledType.body)
                    Text("Off by default. Runs only where the deployment and the queued job permit it.")
                        .font(UnfiledType.secondary)
                        .foregroundStyle(UnfiledTheme.fog)
                }
                .fixedSize(horizontal: false, vertical: true)
            }
            .tint(UnfiledTheme.persimmon)
            .disabled(isAISettingsDraftLocked)
            .settingsRow()
            .padding(.top, UnfiledTheme.sectionTop)
            .accessibilityIdentifier(AISettingsAccessibilityIdentifier.fallback)
        }
    }

    // MARK: Automatic filing, account, and this phone

    private var automaticFilingGroup: some View {
        SettingsGroup(label: "Automatic filing") {
            SettingsNavigationRow(
                title: "Routing rules",
                accessibilityHint: "Opens automatic filing rules",
                accessibilityIdentifier: RoutingRuleAccessibilityIdentifier.settingsLink,
                action: onOpenRoutingRules
            )
        }
    }

    private var accountGroup: some View {
        SettingsGroup(label: "Account") {
            SettingsInfoRow(title: "Signed in", value: email)
            SettingsInfoRow(title: "Backend", value: apiHost)
            SettingsButtonRow(
                title: isSigningOut ? "Signing out…" : "Sign out",
                emphasis: .accent,
                isBusy: isSigningOut,
                accessibilityHint: "Asks before signing out on this iPhone"
            ) {
                confirmsSignOut = true
            }
            AccountDataControls(
                exportArtifact: accountExportArtifact,
                isPreparingExport: isPreparingAccountExport,
                exportError: accountExportError,
                isDeletingAccount: isDeletingAccount,
                hasPendingDeletionReplay: hasPendingAccountDeletionReplay,
                deletionError: accountDeletionError,
                onPrepareExport: onPrepareAccountExport,
                onDiscardExport: onDiscardAccountExport,
                onDeleteAccount: onDeleteAccount
            )
        }
    }

    private var phoneGroup: some View {
        SettingsGroup(label: "On this phone") {
            SettingsNoteRow(
                glyph: .lock,
                text: "Notes and pending captures live in an encrypted database whose key never leaves this iPhone’s Keychain."
            )
        }
    }

    // MARK: Draft changes

    /// Every change goes through here: the draft is replaced, never mutated in place, and saved
    /// at once through the settings contract. A locked draft ignores changes.
    private func apply(_ change: (AISettingsDraft) -> AISettingsDraft) {
        guard let draft, !isAISettingsDraftLocked, !isBusy else { return }
        let next = change(draft)
        guard next != draft else { return }
        self.draft = next
        Task { @MainActor in _ = await onSaveAISettings(next) }
    }

    private func apply<Value>(_ keyPath: WritableKeyPath<AISettingsDraft, Value>, _ value: Value) {
        apply { draft in
            var next = draft
            next[keyPath: keyPath] = value
            return next
        }
    }

    /// Resubmits the locked draft unchanged, so the retry carries the same action key.
    private func retrySettingsDraft() {
        guard let draft else { return }
        Task { @MainActor in _ = await onSaveAISettings(draft) }
    }

    private var fallbackBinding: Binding<Bool> {
        Binding(
            get: { draft?.byokFallbackToApp ?? false },
            set: { value in apply(\.byokFallbackToApp, value) }
        )
    }

    private var deletionDialogIsPresented: Binding<Bool> {
        Binding(
            get: { providerPendingDeletion != nil },
            set: { isPresented in
                if !isPresented { providerPendingDeletion = nil }
            }
        )
    }

    private var selectedProviderForNewCaptures: AIProvider? {
        guard let aiSettings, aiSettings.providerMode == .byok else { return nil }
        return aiSettings.byokProvider
    }

    private var isAISettingsDraftLocked: Bool {
        AISettingsRetryContract.controlsAreLocked(
            isLoading: isLoadingAISettings,
            isSaving: isSavingAISettings,
            hasPendingRetry: hasPendingAISettingsRetry,
            isReconcilingRetry: isReconcilingAISettingsRetry
        )
    }

    private var isBusy: Bool {
        isLoadingAISettings || isSavingAISettings || providerKeyMutation != nil ||
            isReconcilingAISettingsRetry || isSigningOut || isPreparingAccountExport ||
            isDeletingAccount
    }

    /// The first adoption also aims the key field at the saved provider; later ones leave the
    /// chip where the user put it.
    private func adopt(_ settings: UserSettings?) {
        guard let settings else { return }
        if draft == nil, let provider = settings.byokProvider {
            keyProvider = provider
        }
        draft = makeDraft(settings)
    }

    private func makeDraft(_ settings: UserSettings) -> AISettingsDraft {
        AISettingsDraft(settings: settings)
            .applyingManagedFallbackAvailability(isManagedFallbackAvailable)
    }

    private func reconcileAndDiscardSettingsRetry() {
        guard !isReconcilingAISettingsRetry else { return }
        isReconcilingAISettingsRetry = true
        Task { @MainActor in
            if let authoritative = await onDiscardAISettingsRetry() {
                draft = makeDraft(authoritative)
            }
            isReconcilingAISettingsRetry = false
        }
    }

    private func signOut() {
        isSigningOut = true
        Task { @MainActor in
            await onSignOut()
            isSigningOut = false
        }
    }
}
