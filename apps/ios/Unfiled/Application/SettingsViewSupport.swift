import SwiftUI

enum AISettingsAccessibilityIdentifier {
    static let screen = "settings.ai.screen"
    static let loading = "settings.ai.loading"
    static let settingsError = "settings.ai.error"
    static let providerMode = "settings.ai.provider-mode"
    static let provider = "settings.ai.provider"
    static let model = "settings.ai.model"
    static let routingEffort = "settings.ai.routing-effort"
    static let organizationMode = "settings.ai.organization-mode"
    static let expansionStyle = "settings.ai.expansion-style"
    static let fallback = "settings.ai.fallback"
    static let timezone = "settings.ai.timezone"
    static let locale = "settings.ai.locale"
    static let save = "settings.ai.save"
    static let settingsRetryDiscard = "settings.ai.retry-discard"
    static let keySection = "settings.ai.key"
    static let keyStatus = "settings.ai.key-status"
    static let keyInput = "settings.ai.key-input"
    static let keyError = "settings.ai.key-error"
    static let keySave = "settings.ai.key-save"
    static let keyRetryDiscard = "settings.ai.key-retry-discard"
    static let keyDelete = "settings.ai.key-delete"

    /// Key controls exist once per provider, so their identifiers carry the provider as a suffix.
    static func scoped(_ identifier: String, _ provider: AIProvider) -> String {
        "\(identifier).\(provider.rawValue)"
    }

    /// The choice lists moved to pushed pages; the row that opens each page carries this suffix.
    static func row(_ identifier: String) -> String {
        "\(identifier).row"
    }
}

enum AISettingsControlLayout {
    /// Space between the last help line under a credential field and its action row, so a submit
    /// button never reads as part of the text field.
    static let credentialFieldActionGap: CGFloat = 14
    static let credentialActionSpacing: CGFloat = UnfiledTheme.controlGap
    static let credentialActionMinimumHeight: CGFloat = UnfiledTheme.controlHeight
    static let destructiveActionMinimumWidth: CGFloat = 96
    static let fieldHelpSpacing: CGFloat = 8
    static let sectionContentSpacing: CGFloat = 14
    static let optionSpacing: CGFloat = UnfiledTheme.controlGap
    /// Settings rows: one line of body text between hairlines, never shorter than a control.
    static let rowMinimumHeight: CGFloat = UnfiledTheme.controlHeight
    static let rowVerticalPadding: CGFloat = 14
    /// Gap between a row's title and the value or glyph on its right.
    static let rowValueSpacing: CGFloat = 12
}

enum AISettingsCopy {
    static func accessTitle(_ mode: ProviderMode) -> String {
        switch mode {
        case .byok: "My API key"
        case .appDefault: "Unfiled managed"
        }
    }

    static func accessDetail(_ mode: ProviderMode) -> String {
        switch mode {
        case .byok: "Billed to the provider account behind your key."
        case .appDefault: "Funded by this deployment; no key needed."
        }
    }

    static let accessIntro = "Which account pays for organizing new captures."
    static let effortIntro = "More effort means more reasoning, latency, and cost. Safety and trust thresholds never change."
    static let modelIntro = "Automatic follows the effort setting. An exact model stays selected until you change it."
    static let expansionIntro = "Generated additions stay separate from your writing until you accept or reject them."
    static let behaviorIntro = "Sets the confidence needed to file a capture without review."
    static func organizationTitle(_ mode: OrganizationMode) -> String {
        switch mode {
        case .cautious: "Cautious"
        case .balanced: "Balanced"
        case .automatic: "Automatic"
        }
    }

    static func organizationDetail(_ mode: OrganizationMode) -> String {
        switch mode {
        case .cautious: "Asks for review unless the destination is exceptionally clear."
        case .balanced: "Files clear matches and sends uncertain ones to Review."
        case .automatic: "Files more assertively while keeping validation and safety unchanged."
        }
    }

    static func routingTitle(_ effort: RoutingEffort) -> String {
        switch effort {
        case .economical: "Efficient"
        case .standard: "Balanced"
        case .thorough: "Thorough"
        }
    }

    static func routingDetail(_ effort: RoutingEffort) -> String {
        switch effort {
        case .economical: "Smallest approved tier · up to 6 candidates · lowest cost."
        case .standard: "Default approved tier · up to 8 candidates."
        case .thorough: "Stronger fallback and a second low-margin sample · highest cost."
        }
    }

    static func expansionTitle(_ style: ExpansionStyle) -> String {
        switch style {
        case .off: "Off"
        case .brief: "Brief"
        case .detailed: "Detailed"
        }
    }

    static func expansionDetail(_ style: ExpansionStyle) -> String {
        switch style {
        case .off: "Never proposes a generated block."
        case .brief: "May propose a separate addition up to 200 characters."
        case .detailed: "May propose a separate addition up to 600 characters."
        }
    }
}

struct SettingsLabeledField<Content: View>: View {
    let label: String
    let content: Content

    init(_ label: String, @ViewBuilder content: () -> Content) {
        self.label = label
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AISettingsControlLayout.fieldHelpSpacing) {
            EditorialEyebrow(text: label)
            content
                .padding(.horizontal, UnfiledTheme.fieldPadding)
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight, alignment: .leading)
                .background(UnfiledTheme.raised)
                .overlay {
                    RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                        .stroke(UnfiledTheme.border)
                }
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        }
    }
}

struct SettingsInlineMessage: View {
    enum Kind {
        case error, warning

        var glyph: UnfiledGlyph {
            switch self {
            case .error: .warning
            case .warning: .clock
            }
        }

        var color: Color {
            switch self {
            case .error: UnfiledTheme.persimmon
            case .warning: UnfiledTheme.fog
            }
        }
    }

    let message: String
    let kind: Kind
    var accessibilityIdentifier: String?

    var body: some View {
        if let accessibilityIdentifier {
            label.accessibilityIdentifier(accessibilityIdentifier)
        } else {
            label
        }
    }

    private var label: some View {
        Label {
            Text(message)
                .font(UnfiledType.secondary)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            GlyphView(glyph: kind.glyph, size: 14, weight: 1.6)
        }
        .foregroundStyle(kind.color)
    }
}

/// Filled accent action. Used once per form region so the primary path is unmistakable.
struct SettingsPrimaryButton: View {
    let title: String
    let loadingTitle: String
    let isLoading: Bool
    let isDisabled: Bool
    var glyph: UnfiledGlyph?
    let accessibilityIdentifier: String
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .tint(UnfiledTheme.ink)
                        .accessibilityHidden(true)
                }
                Text(isLoading ? loadingTitle : title)
                    .font(UnfiledType.secondaryStrong)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                if let glyph, !isLoading {
                    GlyphView(glyph: glyph, size: 14, weight: 1.9)
                }
            }
            .padding(.horizontal, UnfiledTheme.fieldPadding)
            .padding(.vertical, 8)
            .frame(
                maxWidth: .infinity,
                minHeight: AISettingsControlLayout.credentialActionMinimumHeight
            )
            .foregroundStyle(UnfiledTheme.ink)
            .background(isDisabled ? UnfiledTheme.fog : UnfiledTheme.persimmon)
            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .accessibilityIdentifier(accessibilityIdentifier)
        .accessibilityLabel(isLoading ? loadingTitle : title)
        .accessibilityValue(isLoading ? "In progress" : "")
    }
}

/// The filled accent action at its compact width, for sitting beside a field on one line.
struct SettingsInlinePrimaryButton: View {
    let title: String
    let isLoading: Bool
    let isDisabled: Bool
    let accessibilityLabel: String
    let accessibilityHint: String
    let accessibilityIdentifier: String
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if isLoading {
                    ProgressView()
                        .controlSize(.small)
                        .tint(UnfiledTheme.ink)
                        .accessibilityHidden(true)
                }
                Text(title)
                    .font(UnfiledType.secondaryStrong)
                    .lineLimit(1)
            }
            .padding(.horizontal, UnfiledTheme.fieldPadding)
            .frame(minHeight: UnfiledTheme.controlHeight)
            .foregroundStyle(UnfiledTheme.ink)
            .background(isDisabled && !isLoading ? UnfiledTheme.fog : UnfiledTheme.persimmon)
            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled || isLoading)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(accessibilityHint)
        .accessibilityValue(isLoading ? "In progress" : "")
        .accessibilityIdentifier(accessibilityIdentifier)
    }
}

/// The two ways out of a save whose result is unknown: retry the exact draft, or reload the
/// authoritative copy. Shown wherever the locked draft is visible.
struct SettingsRetryBanner: View {
    let isRetrying: Bool
    let isReconciling: Bool
    let isBusy: Bool
    let stacksVertically: Bool
    let onDiscard: @MainActor () -> Void
    let onRetry: @MainActor () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: AISettingsControlLayout.credentialActionSpacing) {
            SettingsInlineMessage(
                message: "The last save could not be confirmed. Retry the exact same change, or discard it and reload the saved copy.",
                kind: .warning
            )
            SettingsActionRow(stacksVertically: stacksVertically) { fillsWidth in
                SettingsSecondaryButton(
                    title: isReconciling ? "Checking server…" : "Discard and reload",
                    role: .neutral,
                    isDisabled: isBusy,
                    fillsWidth: fillsWidth,
                    accessibilityHint: "Reloads the authoritative server settings before unlocking the draft",
                    accessibilityIdentifier: AISettingsAccessibilityIdentifier.settingsRetryDiscard,
                    action: onDiscard
                )
            } primary: {
                SettingsPrimaryButton(
                    title: "Retry exact save",
                    loadingTitle: "Retrying exact save…",
                    isLoading: isRetrying,
                    isDisabled: isBusy,
                    accessibilityIdentifier: AISettingsAccessibilityIdentifier.save,
                    action: onRetry
                )
                .accessibilityHint("Retries the unchanged request with the same action key")
            }
        }
    }
}

/// Outlined secondary action. Destructive variants keep the accent as a stroke and text only,
/// so they never compete with the filled primary action.
struct SettingsSecondaryButton: View {
    enum Role {
        case neutral, destructive
    }

    let title: String
    let role: Role
    let isDisabled: Bool
    var fillsWidth = false
    let accessibilityHint: String
    let accessibilityIdentifier: String
    let action: @MainActor () -> Void

    private var foreground: Color {
        role == .destructive ? UnfiledTheme.persimmon : UnfiledTheme.paper
    }

    private var stroke: Color {
        role == .destructive ? UnfiledTheme.persimmon.opacity(0.55) : UnfiledTheme.border
    }

    var body: some View {
        Button(role: role == .destructive ? .destructive : nil, action: action) {
            Text(title)
                .font(UnfiledType.secondaryStrong)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(isDisabled ? foreground.opacity(0.55) : foreground)
                .padding(.horizontal, UnfiledTheme.fieldPadding)
                .padding(.vertical, 8)
                .frame(
                    minWidth: AISettingsControlLayout.destructiveActionMinimumWidth,
                    maxWidth: fillsWidth ? .infinity : nil,
                    minHeight: AISettingsControlLayout.credentialActionMinimumHeight
                )
                .background(UnfiledTheme.raised)
                .overlay {
                    RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                        .stroke(stroke, lineWidth: 1)
                }
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .accessibilityHint(accessibilityHint)
        .accessibilityIdentifier(accessibilityIdentifier)
    }
}

/// Lays a secondary and a primary action side by side when they fit, and stacks them (primary
/// first) at accessibility text sizes or narrow widths so neither control is squeezed.
struct SettingsActionRow<Secondary: View, Primary: View>: View {
    let stacksVertically: Bool
    let secondary: (_ fillsWidth: Bool) -> Secondary
    let primary: Primary

    init(
        stacksVertically: Bool,
        @ViewBuilder secondary: @escaping (_ fillsWidth: Bool) -> Secondary,
        @ViewBuilder primary: () -> Primary
    ) {
        self.stacksVertically = stacksVertically
        self.secondary = secondary
        self.primary = primary()
    }

    var body: some View {
        if stacksVertically {
            stacked
        } else {
            ViewThatFits(in: .horizontal) {
                sideBySide
                stacked
            }
        }
    }

    private var sideBySide: some View {
        HStack(alignment: .center, spacing: AISettingsControlLayout.credentialActionSpacing) {
            secondary(false)
            primary
        }
    }

    private var stacked: some View {
        VStack(spacing: AISettingsControlLayout.credentialActionSpacing) {
            primary
            secondary(true)
        }
    }
}

extension View {
    func settingsSupportingText() -> some View {
        font(UnfiledType.secondary)
            .foregroundStyle(UnfiledTheme.fog)
            .fixedSize(horizontal: false, vertical: true)
    }
}
