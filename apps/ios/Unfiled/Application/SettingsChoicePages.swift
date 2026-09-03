import SwiftUI

struct SettingsChoiceOption<Value: Hashable>: Identifiable {
    let value: Value
    let title: String
    let detail: String?

    var id: Value { value }
}

/// A pushed page listing one choice per row; the selected row carries the check. Selecting a row
/// hands the value back to Settings, which saves it through the existing settings contract.
struct SettingsChoicePage<Value: Hashable, Footer: View>: View {
    let title: String
    let intro: String?
    let options: [SettingsChoiceOption<Value>]
    let selection: Value
    let isLocked: Bool
    let accessibilityIdentifier: String
    let onSelect: @MainActor (Value) -> Void
    @ViewBuilder let footer: () -> Footer

    init(
        title: String,
        intro: String?,
        options: [SettingsChoiceOption<Value>],
        selection: Value,
        isLocked: Bool,
        accessibilityIdentifier: String,
        onSelect: @escaping @MainActor (Value) -> Void,
        @ViewBuilder footer: @escaping () -> Footer
    ) {
        self.title = title
        self.intro = intro
        self.options = options
        self.selection = selection
        self.isLocked = isLocked
        self.accessibilityIdentifier = accessibilityIdentifier
        self.onSelect = onSelect
        self.footer = footer
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ScreenHeader(title: title, subtitle: intro, showsMark: false)
                    .padding(.top, UnfiledTheme.pushedHeaderTop)
                VStack(spacing: 0) {
                    SectionRule()
                    ForEach(options) { option in
                        SettingsChoiceRow(
                            title: option.title,
                            detail: option.detail,
                            isSelected: option.value == selection,
                            isDisabled: isLocked
                        ) {
                            onSelect(option.value)
                        }
                    }
                }
                .padding(.top, UnfiledTheme.headerBottom)
                .accessibilityIdentifier(accessibilityIdentifier)
                footer()
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, UnfiledTheme.pushedScreenBottom)
        }
        .navigationBarTitleDisplayMode(.inline)
        .unfiledScreen()
    }
}

extension SettingsChoicePage where Footer == EmptyView {
    init(
        title: String,
        intro: String?,
        options: [SettingsChoiceOption<Value>],
        selection: Value,
        isLocked: Bool,
        accessibilityIdentifier: String,
        onSelect: @escaping @MainActor (Value) -> Void
    ) {
        self.init(
            title: title,
            intro: intro,
            options: options,
            selection: selection,
            isLocked: isLocked,
            accessibilityIdentifier: accessibilityIdentifier,
            onSelect: onSelect
        ) {
            EmptyView()
        }
    }
}

/// The timezone and locale page. Edits stay local until Save so a half-typed timezone never
/// rides along with another setting's save.
struct SettingsDayBoundaryPage<Footer: View>: View {
    let draft: AISettingsDraft
    let isLocked: Bool
    let isSaving: Bool
    let hasPendingRetry: Bool
    let onSave: @MainActor (AISettingsDraft) -> Void
    @ViewBuilder let footer: () -> Footer

    @State private var timezone: String
    @State private var locale: String
    @FocusState private var focusedField: Field?

    private enum Field: Hashable {
        case timezone, locale
    }

    init(
        draft: AISettingsDraft,
        isLocked: Bool,
        isSaving: Bool,
        hasPendingRetry: Bool,
        onSave: @escaping @MainActor (AISettingsDraft) -> Void,
        @ViewBuilder footer: @escaping () -> Footer
    ) {
        self.draft = draft
        self.isLocked = isLocked
        self.isSaving = isSaving
        self.hasPendingRetry = hasPendingRetry
        self.onSave = onSave
        self.footer = footer
        _timezone = State(initialValue: draft.timezone)
        _locale = State(initialValue: draft.locale)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                ScreenHeader(
                    title: "Day boundary",
                    subtitle: "The timezone dates future daily notes. Existing notes are never re-dated.",
                    showsMark: false
                )
                .padding(.top, UnfiledTheme.pushedHeaderTop)

                VStack(alignment: .leading, spacing: UnfiledTheme.formActionSpacing) {
                    SettingsLabeledField("Timezone") {
                        TextField("America/Los_Angeles", text: $timezone)
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
                    SettingsLabeledField("Locale") {
                        TextField("en-US", text: $locale)
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
                    if let message = candidate.validationMessage {
                        SettingsInlineMessage(message: message, kind: .error)
                    }
                    if !hasPendingRetry {
                        SettingsPrimaryButton(
                            title: "Save for next capture",
                            loadingTitle: "Saving…",
                            isLoading: isSaving,
                            isDisabled: isLocked || !canSave,
                            accessibilityIdentifier: AISettingsAccessibilityIdentifier.save
                        ) {
                            focusedField = nil
                            onSave(candidate)
                        }
                        .accessibilityHint("Applies the timezone and locale to captures accepted after the save")
                    }
                }
                .padding(.top, UnfiledTheme.headerBottom)
                .disabled(isLocked)

                footer()
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, UnfiledTheme.pushedScreenBottom)
        }
        .scrollDismissesKeyboard(.interactively)
        .navigationBarTitleDisplayMode(.inline)
        .unfiledScreen()
    }

    private var candidate: AISettingsDraft {
        var next = draft
        next.timezone = timezone
        next.locale = locale
        return next
    }

    private var canSave: Bool {
        let next = candidate
        guard next.validationMessage == nil, !isSaving else { return false }
        return next.normalizedTimezone != draft.normalizedTimezone ||
            next.normalizedLocale != draft.normalizedLocale
    }
}
