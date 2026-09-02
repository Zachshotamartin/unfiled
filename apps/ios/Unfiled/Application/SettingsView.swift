import SwiftUI

enum AISettingsAccessibilityIdentifier {
    static let screen = "settings.ai.screen"
    static let loading = "settings.ai.loading"
    static let settingsError = "settings.ai.error"
    static let organizationMode = "settings.ai.organization-mode"
    static let providerMode = "settings.ai.provider-mode"
    static let fallback = "settings.ai.fallback"
    static let routingEffort = "settings.ai.routing-effort"
    static let expansionStyle = "settings.ai.expansion-style"
    static let timezone = "settings.ai.timezone"
    static let locale = "settings.ai.locale"
    static let save = "settings.ai.save"
    static let settingsRetryDiscard = "settings.ai.retry-discard"
    static let keyStatus = "settings.ai.key-status"
    static let keyInput = "settings.ai.key-input"
    static let keySave = "settings.ai.key-save"
    static let keyRetryDiscard = "settings.ai.key-retry-discard"
    static let keyDelete = "settings.ai.key-delete"
}

enum AISettingsControlLayout {
    static let credentialFieldActionGap: CGFloat = 14
    static let credentialActionSpacing: CGFloat = 12
    static let credentialActionMinimumHeight: CGFloat = 50
    static let destructiveActionMinimumWidth: CGFloat = 96
}

struct SettingsView: View {
    @Environment(\.scenePhase) private var scenePhase

    let email: String
    let apiHost: String
    let aiSettings: UserSettings?
    let providerKey: ProviderKeyMetadata?
    let isLoadingAISettings: Bool
    let hasLoadedAISettings: Bool
    let isSavingAISettings: Bool
    let hasPendingAISettingsRetry: Bool
    let isMutatingProviderKey: Bool
    let hasPendingProviderKeyRetry: Bool
    let aiSettingsError: String?
    let providerKeyError: String?
    let accountExportArtifact: AccountExportArtifact?
    let isPreparingAccountExport: Bool
    let accountExportError: String?
    let isDeletingAccount: Bool
    let hasPendingAccountDeletionReplay: Bool
    let accountDeletionError: String?
    let onRefreshAISettings: @MainActor () async -> Void
    let onSaveAISettings: @MainActor (AISettingsDraft) async -> Bool
    let onDiscardAISettingsRetry: @MainActor () async -> UserSettings?
    let onSaveProviderKey: @MainActor (String) async -> Bool
    let onDiscardProviderKeyRetry: @MainActor () -> Void
    let onDeleteProviderKey: @MainActor () async -> Bool
    let onPrepareAccountExport: @MainActor () async -> Void
    let onDiscardAccountExport: @MainActor (AccountExportArtifact) -> Void
    let onDeleteAccount: @MainActor () async -> Bool
    let onOpenRoutingRules: @MainActor () -> Void
    let onSignOut: @MainActor () async -> Void

    @State private var draft: AISettingsDraft?
    @State private var providerKeyInput = ""
    @State private var confirmsProviderKeyDeletion = false
    @State private var confirmsSignOut = false
    @State private var isSigningOut = false
    @State private var isReconcilingAISettingsRetry = false
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case timezone, locale, providerKey
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                header

                if isLoadingAISettings, aiSettings == nil {
                    loadingState
                } else if let aiSettings, draft != nil {
                    behaviorSettings.disabled(isAISettingsDraftLocked)
                    modelSettings.disabled(isAISettingsDraftLocked)
                    profileSettings.disabled(isAISettingsDraftLocked)
                    providerSettings
                    saveSettingsAction(current: aiSettings)
                } else if hasLoadedAISettings {
                    settingsUnavailableState
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
        .refreshable { await onRefreshAISettings() }
        .confirmationDialog(
            "Delete the saved OpenAI key?",
            isPresented: $confirmsProviderKeyDeletion,
            titleVisibility: .visible
        ) {
            Button("Delete OpenAI key", role: .destructive) {
                Task { @MainActor in _ = await onDeleteProviderKey() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The protected server secret is destroyed immediately. Captures already sent to OpenAI cannot be recalled.")
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
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { clearProviderKeyInput() }
        }
        .onDisappear { clearProviderKeyInput() }
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier(AISettingsAccessibilityIdentifier.screen)
        .unfiledScreen()
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 0) {
            EditorialEyebrow(text: "Account and behavior")
                .padding(.top, 16)
            Text("Settings")
                .font(.system(size: 44, weight: .bold))
                .tracking(-1.7)
                .padding(.top, 8)
            Text("Choose how Unfiled organizes the next thing you capture. Queued work keeps the settings it started with.")
                .font(.system(size: 15))
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
        .accessibilityIdentifier(AISettingsAccessibilityIdentifier.loading)
    }

    private var settingsUnavailableState: some View {
        settingsSection("AI behavior unavailable") {
            inlineError(aiSettingsError ?? "AI settings could not be loaded.")
            Button("Try again") {
                Task { @MainActor in await onRefreshAISettings() }
            }
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(UnfiledTheme.persimmon)
            .frame(minHeight: UnfiledTheme.minimumTouchTarget)
        }
    }

    private var behaviorSettings: some View {
        settingsSection("Organization mode") {
            Text("This changes the confidence thresholds used for the next capture.")
                .settingsSupportingText()
            VStack(spacing: 10) {
                ForEach(OrganizationMode.allCases, id: \.self) { mode in
                    SettingsOptionRow(
                        title: organizationTitle(mode),
                        detail: organizationDetail(mode),
                        value: mode,
                        selection: binding(\.organizationMode, fallback: .balanced)
                    )
                }
            }
            .accessibilityIdentifier(AISettingsAccessibilityIdentifier.organizationMode)
        }
    }

    private var modelSettings: some View {
        Group {
            settingsSection("Routing effort") {
                Text("Effort changes model cost, candidate count, and sampling—not safety or trust thresholds.")
                    .settingsSupportingText()
                VStack(spacing: 10) {
                    ForEach(RoutingEffort.allCases, id: \.self) { effort in
                        SettingsOptionRow(
                            title: routingTitle(effort),
                            detail: routingDetail(effort),
                            value: effort,
                            selection: binding(\.routingEffort, fallback: .standard)
                        )
                    }
                }
                .accessibilityIdentifier(AISettingsAccessibilityIdentifier.routingEffort)
            }

            settingsSection("Generated additions") {
                Text("Generated additions stay separate from your writing until you accept or reject them.")
                    .settingsSupportingText()
                VStack(spacing: 10) {
                    ForEach(ExpansionStyle.allCases, id: \.self) { style in
                        SettingsOptionRow(
                            title: expansionTitle(style),
                            detail: expansionDetail(style),
                            value: style,
                            selection: binding(\.expansionStyle, fallback: .brief)
                        )
                    }
                }
                .accessibilityIdentifier(AISettingsAccessibilityIdentifier.expansionStyle)
            }
        }
    }

    private var profileSettings: some View {
        settingsSection("Locale and day boundary") {
            labeledField("TIMEZONE") {
                TextField(
                    "America/Los_Angeles",
                    text: binding(\.timezone, fallback: TimeZone.current.identifier)
                )
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.asciiCapable)
                .focused($focusedField, equals: .timezone)
                .accessibilityLabel("Timezone")
                .accessibilityHint("Enter an IANA timezone such as America slash Los Angeles")
                .accessibilityIdentifier(AISettingsAccessibilityIdentifier.timezone)
            }
            Text("The timezone determines future daily-note dates. Existing notes are never re-dated.")
                .settingsSupportingText()

            labeledField("LOCALE") {
                TextField("en-US", text: binding(\.locale, fallback: Locale.current.identifier))
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.asciiCapable)
                    .focused($focusedField, equals: .locale)
                    .accessibilityLabel("Locale")
                    .accessibilityHint("Enter a language tag such as en dash US")
                    .accessibilityIdentifier(AISettingsAccessibilityIdentifier.locale)
            }
            if let message = draft?.validationMessage {
                inlineError(message)
            }
        }
    }

    private var providerSettings: some View {
        settingsSection("AI provider") {
            Text("OpenAI is the only provider currently available. Your key is validated before Supabase Vault stores it.")
                .settingsSupportingText()

            VStack(spacing: 10) {
                SettingsOptionRow(
                    title: "Unfiled’s OpenAI access",
                    detail: "Uses the app’s approved model budget and limits.",
                    value: ProviderMode.appDefault,
                    selection: providerModeBinding
                )
                SettingsOptionRow(
                    title: "My OpenAI key",
                    detail: "Provider usage is billed to your OpenAI account; Unfiled’s safety limits still apply.",
                    value: ProviderMode.byok,
                    selection: providerModeBinding
                )
            }
            .disabled(isAISettingsDraftLocked)
            .accessibilityIdentifier(AISettingsAccessibilityIdentifier.providerMode)

            if draft?.providerMode == .byok {
                Toggle(
                    isOn: binding(\.byokFallbackToApp, fallback: false)
                ) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Fall back to Unfiled’s key")
                            .font(.system(size: 15, weight: .semibold))
                        Text("If your saved key is missing or rejected, one app-key transition is allowed for new work.")
                            .font(.system(size: 12))
                            .foregroundStyle(UnfiledTheme.fog)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .tint(UnfiledTheme.persimmon)
                .frame(minHeight: 58)
                .disabled(isAISettingsDraftLocked)
                .accessibilityIdentifier(AISettingsAccessibilityIdentifier.fallback)

                if providerKey?.status != .active, draft?.byokFallbackToApp != true {
                    inlineWarning("BYOK is selected without an active key or fallback. New captures will stay safely in Inbox.")
                }
            }

            providerKeyStatus

            VStack(alignment: .leading, spacing: AISettingsControlLayout.credentialFieldActionGap) {
                labeledField(providerKeyFieldLabel) {
                    SecureField("Paste key", text: $providerKeyInput)
                        .textContentType(nil)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.asciiCapable)
                        .focused($focusedField, equals: .providerKey)
                        .privacySensitive()
                        .accessibilityLabel("OpenAI API key")
                        .accessibilityHint("The key is cleared from this screen as soon as validation begins")
                        .accessibilityIdentifier(AISettingsAccessibilityIdentifier.keyInput)
                        .onSubmit { saveProviderKey() }
                }

                HStack(spacing: AISettingsControlLayout.credentialActionSpacing) {
                    if hasPendingProviderKeyRetry {
                        Button {
                            clearProviderKeyInput()
                            onDiscardProviderKeyRetry()
                        } label: {
                            Text("Start over")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(UnfiledTheme.paper)
                                .frame(
                                    minWidth: AISettingsControlLayout.destructiveActionMinimumWidth,
                                    minHeight: AISettingsControlLayout.credentialActionMinimumHeight
                                )
                                .padding(.horizontal, 10)
                                .background(UnfiledTheme.raised)
                                .overlay {
                                    RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                                        .stroke(UnfiledTheme.border, lineWidth: 1)
                                }
                                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(isBusy)
                        .accessibilityHint("Discards only the retry coordinates, never a stored key")
                        .accessibilityIdentifier(AISettingsAccessibilityIdentifier.keyRetryDiscard)
                    } else if providerKey != nil {
                        Button(role: .destructive) {
                            confirmsProviderKeyDeletion = true
                        } label: {
                            Text("Delete key")
                                .font(.system(size: 15, weight: .semibold))
                                .foregroundStyle(UnfiledTheme.persimmon)
                                .frame(
                                    minWidth: AISettingsControlLayout.destructiveActionMinimumWidth,
                                    minHeight: AISettingsControlLayout.credentialActionMinimumHeight
                                )
                                .padding(.horizontal, 10)
                                .background(UnfiledTheme.raised)
                                .overlay {
                                    RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                                        .stroke(UnfiledTheme.persimmon.opacity(0.55), lineWidth: 1)
                                }
                                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(isBusy)
                        .accessibilityHint("Permanently destroys the protected OpenAI key")
                        .accessibilityIdentifier(AISettingsAccessibilityIdentifier.keyDelete)
                    }

                    Spacer(minLength: 8)

                    Button(action: saveProviderKey) {
                        HStack(spacing: 8) {
                            if isMutatingProviderKey { ProgressView().tint(UnfiledTheme.ink) }
                            Text(providerKeyActionTitle)
                            Image(systemName: "arrow.right")
                                .accessibilityHidden(true)
                        }
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(UnfiledTheme.ink)
                        .frame(minHeight: AISettingsControlLayout.credentialActionMinimumHeight)
                        .padding(.horizontal, 15)
                        .background(canSubmitProviderKey ? UnfiledTheme.persimmon : UnfiledTheme.fog)
                        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSubmitProviderKey)
                    .accessibilityIdentifier(AISettingsAccessibilityIdentifier.keySave)
                }
            }

            Text("The key is sent only for validation and Vault storage. It is never returned, saved in app preferences, drafts, analytics, or the on-device database.")
                .settingsSupportingText()

            if let providerKeyError {
                inlineError(providerKeyError)
            }
        }
    }

    private var providerKeyStatus: some View {
        HStack(alignment: .top, spacing: 13) {
            Image(systemName: providerKeyStatusIcon)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(providerKeyStatusColor)
                .frame(width: 24, height: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 5) {
                Text(providerKeyStatusTitle)
                    .font(.system(size: 15, weight: .semibold))
                if let providerKey {
                    Text("OpenAI •••• \(providerKey.lastFour) · revision \(providerKey.credentialRevision)")
                        .font(.system(size: 12, design: .monospaced))
                        .foregroundStyle(UnfiledTheme.fog)
                    if let validatedAt = providerKey.validatedAt {
                        Text("Validated \(validatedAt.formatted(date: .abbreviated, time: .shortened))")
                            .font(.system(size: 12))
                            .foregroundStyle(UnfiledTheme.fog)
                    }
                } else {
                    Text("No credential is available to BYOK jobs.")
                        .font(.system(size: 12))
                        .foregroundStyle(UnfiledTheme.fog)
                }
            }
            Spacer(minLength: 6)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(UnfiledTheme.raised)
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(AISettingsAccessibilityIdentifier.keyStatus)
    }

    private func saveSettingsAction(current: UserSettings) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if let aiSettingsError { inlineError(aiSettingsError) }
            if hasPendingAISettingsRetry {
                HStack(spacing: AISettingsControlLayout.credentialActionSpacing) {
                    Button(isReconcilingAISettingsRetry ? "Checking server…" : "Discard draft and reload") {
                        reconcileAndDiscardSettingsRetry()
                    }
                    .buttonStyle(.bordered)
                    .tint(UnfiledTheme.fog)
                    .frame(minHeight: AISettingsControlLayout.credentialActionMinimumHeight)
                    .disabled(isBusy)
                    .accessibilityHint("Reloads the authoritative server settings before unlocking the draft")
                    .accessibilityIdentifier(
                        AISettingsAccessibilityIdentifier.settingsRetryDiscard
                    )

                    PrimaryActionButton(
                        title: isSavingAISettings ? "Retrying exact save…" : "Retry exact save",
                        systemImage: "arrow.clockwise",
                        disabled: isBusy || draft == nil
                    ) {
                        submitSettingsDraft()
                    }
                    .accessibilityHint("Retries the unchanged request with the same action key")
                    .accessibilityIdentifier(AISettingsAccessibilityIdentifier.save)
                }
            } else {
                PrimaryActionButton(
                    title: isSavingAISettings ? "Saving settings…" : "Save for next capture",
                    systemImage: "arrow.right",
                    disabled: !canSaveSettings(current: current)
                ) {
                    submitSettingsDraft()
                }
                .accessibilityHint("Applies these choices to captures accepted after the save")
                .accessibilityIdentifier(AISettingsAccessibilityIdentifier.save)
            }
        }
        .padding(.top, 24)
        .padding(.bottom, 8)
    }

    private var accountAndDeviceSettings: some View {
        Group {
            settingsSection("Signed in") {
                Label(email, systemImage: "person.crop.circle")
                metadata("Shared backend", value: apiHost)
            }

            settingsSection("Protected storage") {
                Label("SQLCipher-encrypted local database", systemImage: "lock.shield")
                Text("This iPhone stores drafts, cached notes, and pending captures in SQLCipher. Its key stays in this device’s Keychain and is not synchronized to iCloud. Provider keys never enter that database.")
                    .settingsSupportingText()
            }

            settingsSection("Automatic filing") {
                Button(action: onOpenRoutingRules) {
                    HStack(spacing: 14) {
                        Image(systemName: "arrow.triangle.branch")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(UnfiledTheme.persimmon)
                            .frame(width: 28)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 4) {
                            Text("Routing rules")
                                .font(.system(size: 16, weight: .semibold))
                                .foregroundStyle(UnfiledTheme.paper)
                            Text("Choose where familiar captures should go")
                                .font(.system(size: 13))
                                .foregroundStyle(UnfiledTheme.fog)
                        }
                        Spacer(minLength: 10)
                        Image(systemName: "chevron.right")
                            .font(.system(size: 13, weight: .semibold))
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

            settingsSection("Lock Screen capture") {
                Label("Quick Capture widget", systemImage: "rectangle.on.rectangle")
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
            .font(.system(size: 16, weight: .semibold))
            .foregroundStyle(UnfiledTheme.persimmon)
            .frame(minHeight: 54)
        }
        .buttonStyle(.plain)
        .disabled(isSigningOut)
        .padding(.top, 26)
    }

    private var providerModeBinding: Binding<ProviderMode> {
        Binding(
            get: { draft?.providerMode ?? .appDefault },
            set: { value in
                guard !isAISettingsDraftLocked else { return }
                draft?.providerMode = value
                if value == .appDefault { draft?.byokFallbackToApp = false }
            }
        )
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
        isLoadingAISettings || isSavingAISettings || isMutatingProviderKey ||
            isReconcilingAISettingsRetry || isSigningOut || isPreparingAccountExport ||
            isDeletingAccount
    }

    private var canSubmitProviderKey: Bool {
        ProviderKeyInputRules.isValid(providerKeyInput) && !isBusy
    }

    private func canSaveSettings(current: UserSettings) -> Bool {
        guard let draft, draft.validationMessage == nil, !isBusy,
              !hasPendingAISettingsRetry else { return false }
        return ((try? draft.makeUpdateRequest(
            comparedTo: current,
            idempotencyKey: "settings-ui-validation"
        )) ?? nil) != nil
    }

    private func adopt(_ settings: UserSettings?) {
        guard let settings else { return }
        draft = AISettingsDraft(settings: settings)
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
                draft = AISettingsDraft(settings: authoritative)
            }
            isReconcilingAISettingsRetry = false
        }
    }

    private func saveProviderKey() {
        guard canSubmitProviderKey else { return }
        let submittedKey = providerKeyInput
        clearProviderKeyInput()
        Task { @MainActor in _ = await onSaveProviderKey(submittedKey) }
    }

    private func clearProviderKeyInput() {
        focusedField = nil
        providerKeyInput.removeAll(keepingCapacity: false)
    }

    private func settingsSection<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .tracking(1)
                .foregroundStyle(UnfiledTheme.fog)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 22)
        .overlay(alignment: .bottom) { SectionRule() }
    }

    private func labeledField<Content: View>(
        _ label: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .tracking(0.8)
                .foregroundStyle(UnfiledTheme.fog)
            content()
                .padding(.horizontal, 14)
                .frame(maxWidth: .infinity, minHeight: 50, alignment: .leading)
                .background(UnfiledTheme.raised)
                .overlay {
                    RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                        .stroke(UnfiledTheme.border)
                }
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        }
    }

    private func inlineError(_ message: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.system(size: 13))
            .foregroundStyle(UnfiledTheme.persimmon)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(AISettingsAccessibilityIdentifier.settingsError)
    }

    private func inlineWarning(_ message: String) -> some View {
        Label(message, systemImage: "tray.full")
            .font(.system(size: 13))
            .foregroundStyle(UnfiledTheme.fog)
            .fixedSize(horizontal: false, vertical: true)
    }

    private func metadata(_ label: String, value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(UnfiledTheme.fog)
            Spacer()
            Text(value).font(.system(size: 12, design: .monospaced))
        }
        .font(.system(size: 14))
    }

    private var providerKeyStatusTitle: String {
        switch providerKey?.status {
        case .active: "Saved key active"
        case .invalid: "Saved key rejected"
        case .revoked: "Saved key revoked"
        case nil: "No saved key"
        }
    }

    private var providerKeyFieldLabel: String {
        if hasPendingProviderKeyRetry { return "PASTE THE SAME OPENAI API KEY" }
        return providerKey == nil ? "OPENAI API KEY" : "REPLACEMENT OPENAI API KEY"
    }

    private var providerKeyActionTitle: String {
        if isMutatingProviderKey { return "Validating…" }
        if hasPendingProviderKeyRetry { return "Retry same key" }
        return providerKey == nil ? "Validate and save" : "Validate replacement"
    }

    private var providerKeyStatusIcon: String {
        providerKey?.status == .active ? "checkmark.shield.fill" : "exclamationmark.shield.fill"
    }

    private var providerKeyStatusColor: Color {
        providerKey?.status == .active ? UnfiledTheme.paper : UnfiledTheme.persimmon
    }

    private func organizationTitle(_ mode: OrganizationMode) -> String {
        switch mode {
        case .cautious: "Cautious"
        case .balanced: "Balanced"
        case .automatic: "Automatic"
        }
    }

    private func organizationDetail(_ mode: OrganizationMode) -> String {
        switch mode {
        case .cautious: "Asks for review unless the destination is exceptionally clear."
        case .balanced: "Files clear matches and sends uncertain ones to Review."
        case .automatic: "Files more assertively while keeping validation and safety unchanged."
        }
    }

    private func routingTitle(_ effort: RoutingEffort) -> String {
        switch effort {
        case .economical: "Economical"
        case .standard: "Standard"
        case .thorough: "Thorough"
        }
    }

    private func routingDetail(_ effort: RoutingEffort) -> String {
        let appCopy: String
        switch effort {
        case .economical: appCopy = "Smallest approved tier · up to 6 candidates · lowest cost."
        case .standard: appCopy = "Default approved tier · up to 8 candidates."
        case .thorough: appCopy = "Stronger fallback and a second low-margin sample · highest cost."
        }
        return draft?.providerMode == .byok ? "OpenAI bills your key. \(appCopy)" : appCopy
    }

    private func expansionTitle(_ style: ExpansionStyle) -> String {
        switch style {
        case .off: "Off"
        case .brief: "Brief"
        case .detailed: "Detailed"
        }
    }

    private func expansionDetail(_ style: ExpansionStyle) -> String {
        switch style {
        case .off: "Never proposes a generated block."
        case .brief: "May propose a separate addition up to 200 characters."
        case .detailed: "May propose a separate addition up to 600 characters."
        }
    }

    private func signOut() {
        clearProviderKeyInput()
        isSigningOut = true
        Task { @MainActor in
            await onSignOut()
            isSigningOut = false
        }
    }
}

private struct SettingsOptionRow<Value: Hashable>: View {
    let title: String
    let detail: String
    let value: Value
    @Binding var selection: Value

    private var isSelected: Bool { selection == value }

    var body: some View {
        Button {
            selection = value
        } label: {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: isSelected ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 18, weight: .medium))
                    .foregroundStyle(isSelected ? UnfiledTheme.persimmon : UnfiledTheme.fog)
                    .frame(width: 24, height: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(UnfiledTheme.paper)
                    Text(detail)
                        .font(.system(size: 12))
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 4)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
            .background(isSelected ? UnfiledTheme.raised : UnfiledTheme.graphite)
            .overlay {
                RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                    .stroke(isSelected ? UnfiledTheme.persimmon : UnfiledTheme.border)
            }
            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title). \(detail)")
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}

private extension View {
    func settingsSupportingText() -> some View {
        font(.system(size: 13))
            .foregroundStyle(UnfiledTheme.fog)
            .fixedSize(horizontal: false, vertical: true)
    }
}
