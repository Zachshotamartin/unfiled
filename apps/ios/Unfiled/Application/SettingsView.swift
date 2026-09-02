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
    @State private var providerPendingDeletion: AIProvider?
    @State private var confirmsSignOut = false
    @State private var isSigningOut = false
    @State private var isReconcilingAISettingsRetry = false
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case timezone, locale
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header

                if isLoadingAISettings, aiSettings == nil {
                    loadingState
                } else {
                    if let aiSettings, draft != nil {
                        aiSettingsSections(current: aiSettings)
                    } else if hasLoadedAISettings {
                        settingsUnavailableState
                    }
                    if hasLoadedAISettings {
                        providerKeySections
                    }
                }

                accountAndDeviceSettings
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
                signOutAction
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, 48)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await onRefreshAISettings() }
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
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier(AISettingsAccessibilityIdentifier.screen)
        .unfiledScreen()
    }

    // MARK: Header and load states

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            EditorialEyebrow(text: "Account and behavior")
                .padding(.top, 16)
            Text("Settings")
                .font(.system(.largeTitle, weight: .bold))
                .tracking(-1.2)
                .accessibilityAddTraits(.isHeader)
                .padding(.top, 8)
            Text("Choose how Unfiled organizes the next thing you capture. Queued work keeps the settings it started with.")
                .font(.system(.subheadline))
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
                .padding(.bottom, 16)
        }
    }

    private var loadingState: some View {
        HStack(spacing: 12) {
            ProgressView()
            Text("Loading protected AI settings…")
                .foregroundStyle(UnfiledTheme.fog)
        }
        .frame(maxWidth: .infinity, minHeight: 150, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(AISettingsAccessibilityIdentifier.loading)
    }

    private var settingsUnavailableState: some View {
        SettingsSection("AI behavior unavailable") {
            SettingsInlineMessage(
                message: aiSettingsError ?? "AI settings could not be loaded.",
                kind: .error,
                accessibilityIdentifier: AISettingsAccessibilityIdentifier.settingsError
            )
            Button("Try again") {
                Task { @MainActor in await onRefreshAISettings() }
            }
            .font(.system(.subheadline, weight: .semibold))
            .foregroundStyle(UnfiledTheme.persimmon)
            .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            .accessibilityHint("Reloads AI settings and key status")
        }
    }

    // MARK: Provider, model, effort, then behavior

    @ViewBuilder
    private func aiSettingsSections(current: UserSettings) -> some View {
        Group {
            accessModeSection
            if draft?.providerMode == .byok {
                providerSection
                modelSection
            }
            effortSection
            organizationSection
            expansionSection
            profileSection
        }
        .disabled(isAISettingsDraftLocked)
        saveSettingsAction(current: current)
    }

    private var accessModeSection: some View {
        SettingsSection("AI access") {
            Text(accessModeCopy)
                .settingsSupportingText()
            VStack(spacing: AISettingsControlLayout.optionSpacing) {
                SettingsOptionRow(
                    title: "My API key",
                    detail: "Usage is billed to the provider account behind the key you choose below.",
                    value: ProviderMode.byok,
                    selection: providerModeBinding
                )
                if offersManagedMode {
                    SettingsOptionRow(
                        title: "Unfiled managed",
                        detail: managedModeDetail,
                        value: ProviderMode.appDefault,
                        selection: providerModeBinding
                    )
                }
            }
            .accessibilityIdentifier(AISettingsAccessibilityIdentifier.providerMode)

            if offersManagedMode, !isManagedFallbackAvailable {
                SettingsInlineMessage(
                    message: "This deployment does not fund AI, so managed access cannot organize new captures. Choose My API key, pick a provider, and add a key below.",
                    kind: .warning
                )
            }
        }
    }

    private var offersManagedMode: Bool {
        ManagedFallbackContract.offersManagedMode(
            isAvailable: isManagedFallbackAvailable,
            savedMode: aiSettings?.providerMode ?? .byok
        )
    }

    private var accessModeCopy: String {
        isManagedFallbackAvailable
            ? "Use your own provider key, or managed access funded by this deployment."
            : "Use your own provider key. The free beta does not include app-funded inference."
    }

    private var managedModeDetail: String {
        isManagedFallbackAvailable
            ? "This deployment funds AI access, so no key is required."
            : "Saved earlier. Not funded on this deployment; new captures wait until a key is added."
    }

    private var providerSection: some View {
        SettingsSection("Provider") {
            Text("Choose which saved key and model family handles new captures. Switching keeps both keys saved.")
                .settingsSupportingText()
            VStack(spacing: AISettingsControlLayout.optionSpacing) {
                ForEach(AIProvider.allCases, id: \.self) { provider in
                    SettingsOptionRow(
                        title: provider.displayName,
                        detail: providerDetail(provider),
                        value: provider,
                        selection: providerBinding
                    )
                }
            }
            .accessibilityIdentifier(AISettingsAccessibilityIdentifier.provider)

            if ManagedFallbackContract.showsFallbackToggle(isAvailable: isManagedFallbackAvailable) {
                Toggle(isOn: binding(\.byokFallbackToApp, fallback: false)) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Allow managed fallback when available")
                            .font(.system(.subheadline, weight: .semibold))
                        Text("Off by default. A fallback can run only where the deployment and the queued job permit it.")
                            .font(.system(.caption))
                            .foregroundStyle(UnfiledTheme.fog)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }
                .tint(UnfiledTheme.persimmon)
                .frame(minHeight: 58)
                .accessibilityIdentifier(AISettingsAccessibilityIdentifier.fallback)
            }

            if let provider = draft?.byokProvider,
               providerKeys[provider]?.status != .active,
               draft?.byokFallbackToApp != true {
                SettingsInlineMessage(
                    message: "No active \(provider.displayName) key is saved. New captures stay safely queued until a key or an allowed fallback is available.",
                    kind: .warning
                )
            }
        }
    }

    private var modelSection: some View {
        SettingsSection("Model") {
            Text("Automatic follows the effort setting. An exact model stays selected until you change it, and higher tiers cost more per capture.")
                .settingsSupportingText()
            VStack(spacing: AISettingsControlLayout.optionSpacing) {
                ForEach(modelSelections, id: \.self) { model in
                    SettingsOptionRow(
                        title: AIModelRegistry.label(for: model),
                        detail: modelDetail(model),
                        value: model,
                        selection: binding(\.modelSelection, fallback: .automatic)
                    )
                }
            }
            .accessibilityIdentifier(AISettingsAccessibilityIdentifier.model)
        }
    }

    private var effortSection: some View {
        SettingsSection("Effort") {
            Text("Effort changes provider reasoning, latency, and likely cost. It never changes safety or trust thresholds.")
                .settingsSupportingText()
            VStack(spacing: AISettingsControlLayout.optionSpacing) {
                ForEach(RoutingEffort.allCases, id: \.self) { effort in
                    SettingsOptionRow(
                        title: AISettingsCopy.routingTitle(effort),
                        detail: routingDetail(effort),
                        value: effort,
                        selection: binding(\.routingEffort, fallback: .standard)
                    )
                }
            }
            .accessibilityIdentifier(AISettingsAccessibilityIdentifier.routingEffort)
        }
    }

    private var organizationSection: some View {
        SettingsSection("Organization behavior") {
            Text("This changes the confidence thresholds used for the next capture.")
                .settingsSupportingText()
            VStack(spacing: AISettingsControlLayout.optionSpacing) {
                ForEach(OrganizationMode.allCases, id: \.self) { mode in
                    SettingsOptionRow(
                        title: AISettingsCopy.organizationTitle(mode),
                        detail: AISettingsCopy.organizationDetail(mode),
                        value: mode,
                        selection: binding(\.organizationMode, fallback: .balanced)
                    )
                }
            }
            .accessibilityIdentifier(AISettingsAccessibilityIdentifier.organizationMode)
        }
    }

    private var expansionSection: some View {
        SettingsSection("Generated additions") {
            Text("Generated additions stay separate from your writing until you accept or reject them.")
                .settingsSupportingText()
            VStack(spacing: AISettingsControlLayout.optionSpacing) {
                ForEach(ExpansionStyle.allCases, id: \.self) { style in
                    SettingsOptionRow(
                        title: AISettingsCopy.expansionTitle(style),
                        detail: AISettingsCopy.expansionDetail(style),
                        value: style,
                        selection: binding(\.expansionStyle, fallback: .brief)
                    )
                }
            }
            .accessibilityIdentifier(AISettingsAccessibilityIdentifier.expansionStyle)
        }
    }

    private var profileSection: some View {
        SettingsSection("Locale and day boundary") {
            VStack(alignment: .leading, spacing: AISettingsControlLayout.fieldHelpSpacing) {
                SettingsLabeledField("Timezone") {
                    TextField(
                        "America/Los_Angeles",
                        text: binding(\.timezone, fallback: TimeZone.current.identifier)
                    )
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .submitLabel(.next)
                    .focused($focusedField, equals: .timezone)
                    .onSubmit { focusedField = .locale }
                    .accessibilityLabel("Timezone")
                    .accessibilityHint("Enter an IANA timezone such as America slash Los Angeles")
                    .accessibilityIdentifier(AISettingsAccessibilityIdentifier.timezone)
                }
                Text("The timezone determines future daily-note dates. Existing notes are never re-dated.")
                    .settingsSupportingText()
            }

            VStack(alignment: .leading, spacing: AISettingsControlLayout.fieldHelpSpacing) {
                SettingsLabeledField("Locale") {
                    TextField("en-US", text: binding(\.locale, fallback: Locale.current.identifier))
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.asciiCapable)
                        .submitLabel(.done)
                        .focused($focusedField, equals: .locale)
                        .onSubmit { focusedField = nil }
                        .accessibilityLabel("Locale")
                        .accessibilityHint("Enter a language tag such as en dash US")
                        .accessibilityIdentifier(AISettingsAccessibilityIdentifier.locale)
                }
                if let message = draft?.validationMessage {
                    SettingsInlineMessage(message: message, kind: .error)
                }
            }
        }
    }

    // MARK: Settings save region

    private func saveSettingsAction(current: UserSettings) -> some View {
        VStack(alignment: .leading, spacing: AISettingsControlLayout.credentialActionSpacing) {
            if let aiSettingsError {
                SettingsInlineMessage(
                    message: aiSettingsError,
                    kind: .error,
                    accessibilityIdentifier: AISettingsAccessibilityIdentifier.settingsError
                )
            }
            if hasPendingAISettingsRetry {
                SettingsInlineMessage(
                    message: "The last save could not be confirmed. Retry the exact same draft, or discard it and reload the saved copy.",
                    kind: .warning
                )
                SettingsActionRow(stacksVertically: dynamicTypeSize.isAccessibilitySize) { fillsWidth in
                    SettingsSecondaryButton(
                        title: isReconcilingAISettingsRetry ? "Checking server…" : "Discard draft and reload",
                        role: .neutral,
                        isDisabled: isBusy,
                        fillsWidth: fillsWidth,
                        accessibilityHint: "Reloads the authoritative server settings before unlocking the draft",
                        accessibilityIdentifier: AISettingsAccessibilityIdentifier.settingsRetryDiscard
                    ) {
                        reconcileAndDiscardSettingsRetry()
                    }
                } primary: {
                    SettingsPrimaryButton(
                        title: "Retry exact save",
                        loadingTitle: "Retrying exact save…",
                        isLoading: isSavingAISettings,
                        isDisabled: isBusy || draft == nil,
                        systemImage: "arrow.clockwise",
                        accessibilityIdentifier: AISettingsAccessibilityIdentifier.save
                    ) {
                        submitSettingsDraft()
                    }
                    .accessibilityHint("Retries the unchanged request with the same action key")
                }
            } else {
                SettingsPrimaryButton(
                    title: "Save for next capture",
                    loadingTitle: "Saving settings…",
                    isLoading: isSavingAISettings,
                    isDisabled: !canSaveSettings(current: current),
                    accessibilityIdentifier: AISettingsAccessibilityIdentifier.save
                ) {
                    submitSettingsDraft()
                }
                .accessibilityHint("Applies these choices to captures accepted after the save")
            }
        }
        .padding(.top, 24)
        .padding(.bottom, 8)
    }

    // MARK: Provider keys

    private var providerKeySections: some View {
        ForEach(AIProvider.allCases, id: \.self) { provider in
            ProviderKeySectionView(
                provider: provider,
                metadata: providerKeys[provider],
                isSelectedForNewCaptures: selectedProviderForNewCaptures == provider,
                mutation: providerKeyMutation,
                isLocked: isBusy,
                pendingRetryProvider: pendingProviderKeyRetry,
                errorMessage: providerKeyErrors[provider],
                onSave: onSaveProviderKey,
                onDiscardRetry: onDiscardProviderKeyRetry,
                onRequestDelete: { providerPendingDeletion = $0 }
            )
        }
    }

    // MARK: Account and device

    private var accountAndDeviceSettings: some View {
        Group {
            SettingsSection("Signed in") {
                Label(email, systemImage: "person.crop.circle")
                    .font(.system(.subheadline))
                metadata("Shared backend", value: apiHost)
            }

            SettingsSection("Protected storage") {
                Label("SQLCipher-encrypted local database", systemImage: "lock.shield")
                    .font(.system(.subheadline))
                Text("This iPhone stores drafts, cached notes, and pending captures in SQLCipher. Its key stays in this device’s Keychain and is not synchronized to iCloud. Provider keys never enter that database.")
                    .settingsSupportingText()
            }

            SettingsSection("Automatic filing") {
                Button(action: onOpenRoutingRules) {
                    HStack(spacing: 14) {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(.body, weight: .semibold))
                            .foregroundStyle(UnfiledTheme.persimmon)
                            .frame(width: 28)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Routing rules")
                                .font(.system(.callout, weight: .semibold))
                                .foregroundStyle(UnfiledTheme.paper)
                            Text("Choose where familiar captures should go")
                                .font(.system(.footnote))
                                .foregroundStyle(UnfiledTheme.fog)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 10)
                        Image(systemName: "chevron.right")
                            .font(.system(.footnote, weight: .semibold))
                            .foregroundStyle(UnfiledTheme.fog)
                            .accessibilityHidden(true)
                    }
                    .frame(maxWidth: .infinity, minHeight: 56, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens automatic filing rules")
                .accessibilityIdentifier(RoutingRuleAccessibilityIdentifier.settingsLink)
            }

            SettingsSection("Lock Screen capture") {
                Label("Quick Capture widget", systemImage: "rectangle.on.rectangle")
                    .font(.system(.subheadline))
                Text("Touch and hold the Lock Screen, choose Customize, tap the widget area, then add Unfiled. A tap opens the native composer with the keyboard ready; iOS does not allow free-form typing inside the widget itself.")
                    .settingsSupportingText()
            }
        }
    }

    private var signOutAction: some View {
        Button(role: .destructive) {
            confirmsSignOut = true
        } label: {
            HStack {
                Text(isSigningOut ? "Signing out…" : "Sign out")
                Spacer()
                if isSigningOut { ProgressView() }
            }
            .font(.system(.callout, weight: .semibold))
            .foregroundStyle(UnfiledTheme.persimmon)
            .frame(minHeight: 54)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSigningOut)
        .accessibilityValue(isSigningOut ? "In progress" : "")
        .padding(.top, 26)
    }

    // MARK: Bindings and derived state

    private var providerModeBinding: Binding<ProviderMode> {
        Binding(
            get: { draft?.providerMode ?? .appDefault },
            set: { value in
                guard !isAISettingsDraftLocked else { return }
                draft = draft?.selectingProviderMode(value)
            }
        )
    }

    private var providerBinding: Binding<AIProvider> {
        Binding(
            get: { draft?.byokProvider ?? .openai },
            set: { value in
                guard !isAISettingsDraftLocked else { return }
                draft = draft?.selectingProvider(value)
            }
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

    private var modelSelections: [AIModelSelection] {
        AIModelRegistry.selections(for: draft?.byokProvider ?? .openai)
    }

    private func binding<Value>(
        _ keyPath: WritableKeyPath<AISettingsDraft, Value>,
        fallback: Value
    ) -> Binding<Value> {
        Binding(
            get: { draft?[keyPath: keyPath] ?? fallback },
            set: { value in
                guard !isAISettingsDraftLocked else { return }
                draft?[keyPath: keyPath] = value
            }
        )
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

    private func canSaveSettings(current: UserSettings) -> Bool {
        guard let draft, draft.validationMessage == nil, !isBusy,
              !hasPendingAISettingsRetry else { return false }
        return ((try? draft.makeUpdateRequest(
            comparedTo: current,
            idempotencyKey: "settings-ui-validation",
            managedFallbackAvailable: isManagedFallbackAvailable
        )) ?? nil) != nil
    }

    private func adopt(_ settings: UserSettings?) {
        guard let settings else { return }
        draft = makeDraft(settings)
    }

    private func makeDraft(_ settings: UserSettings) -> AISettingsDraft {
        AISettingsDraft(settings: settings)
            .applyingManagedFallbackAvailability(isManagedFallbackAvailable)
    }

    private func submitSettingsDraft() {
        guard let draft else { return }
        focusedField = nil
        Task { @MainActor in _ = await onSaveAISettings(draft) }
    }

    private func reconcileAndDiscardSettingsRetry() {
        guard !isReconcilingAISettingsRetry else { return }
        focusedField = nil
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

    // MARK: Copy

    private func metadata(_ label: String, value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(UnfiledTheme.fog)
            Spacer()
            Text(value).font(.system(.caption, design: .monospaced))
        }
        .font(.system(.subheadline))
    }

    private func providerDetail(_ provider: AIProvider) -> String {
        let family = AISettingsCopy.providerFamily(provider)
        switch providerKeys[provider] {
        case let metadata? where metadata.status == .active:
            return "\(family) · key active, ending \(metadata.lastFour)."
        case let metadata? where metadata.status == .invalid:
            return "\(family) · saved key was rejected. Replace it below."
        case .some:
            return "\(family) · saved key was revoked. Replace it below."
        case nil:
            return "\(family) · no key saved yet. Add one below."
        }
    }

    private func modelDetail(_ model: AIModelSelection) -> String {
        guard let draft else { return AIModelRegistry.detail(for: model) }
        if model == .automatic {
            let resolved = AIModelRegistry.label(for: draft.resolvedAutomaticModel)
            let effort = AISettingsCopy.routingTitle(draft.routingEffort).lowercased()
            return "Currently resolves to \(resolved) for \(effort) effort."
        }
        let base = AIModelRegistry.detail(for: model)
        return AIModelRegistry.isHigherCost(model) ? "\(base) Higher cost on your key." : base
    }

    private func routingDetail(_ effort: RoutingEffort) -> String {
        let base = AISettingsCopy.routingDetail(effort)
        guard let draft, draft.providerMode == .byok else { return base }
        if draft.modelSelection == .automatic {
            let model = AIModelRegistry.automaticModel(for: draft.byokProvider, effort: effort)
            return "\(base) Automatic uses \(AIModelRegistry.label(for: model))."
        }
        return "\(base) Billed to your \(draft.byokProvider.displayName) key."
    }
}
