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
}

enum AISettingsControlLayout {
    /// Space between the last help line under a credential field and its action row, so a submit
    /// button never reads as part of the text field.
    static let credentialFieldActionGap: CGFloat = 14
    static let credentialActionSpacing: CGFloat = 12
    static let credentialActionMinimumHeight: CGFloat = 50
    static let destructiveActionMinimumWidth: CGFloat = 96
    static let fieldHelpSpacing: CGFloat = 8
    static let sectionContentSpacing: CGFloat = 14
    static let optionSpacing: CGFloat = 10
}

enum AISettingsCopy {
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

    static func keyStatusTitle(_ status: ProviderKeyStatus?) -> String {
        switch status {
        case .active: "Saved key active"
        case .invalid: "Saved key rejected"
        case .revoked: "Saved key revoked"
        case nil: "No saved key"
        }
    }

    static func providerFamily(_ provider: AIProvider) -> String {
        switch provider {
        case .openai: "GPT-5.6 models"
        case .anthropic: "Claude 5 models"
        }
    }
}

struct SettingsSection<Content: View>: View {
    let title: String
    let content: Content

    init(_ title: String, @ViewBuilder content: () -> Content) {
        self.title = title
        self.content = content()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: AISettingsControlLayout.sectionContentSpacing) {
            Text(title)
                .font(.system(.caption2, design: .monospaced, weight: .medium))
                .tracking(1)
                .textCase(.uppercase)
                .foregroundStyle(UnfiledTheme.fog)
                .accessibilityAddTraits(.isHeader)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 22)
        .overlay(alignment: .bottom) { SectionRule() }
    }
}

struct SettingsOptionRow<Value: Hashable>: View {
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
                    .font(.system(.body, weight: .medium))
                    .foregroundStyle(isSelected ? UnfiledTheme.persimmon : UnfiledTheme.fog)
                    .frame(width: 24, height: 24)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    Text(title)
                        .font(.system(.subheadline, weight: .semibold))
                        .foregroundStyle(UnfiledTheme.paper)
                    Text(detail)
                        .font(.system(.caption))
                        .foregroundStyle(UnfiledTheme.fog)
                }
                .fixedSize(horizontal: false, vertical: true)
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
        .accessibilityLabel(title)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityHint(detail)
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
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
            Text(label)
                .font(.system(.caption2, design: .monospaced, weight: .medium))
                .tracking(0.8)
                .textCase(.uppercase)
                .foregroundStyle(UnfiledTheme.fog)
            content
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
}

struct SettingsInlineMessage: View {
    enum Kind {
        case error, warning

        var systemImage: String {
            switch self {
            case .error: "exclamationmark.triangle.fill"
            case .warning: "tray.full"
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
        Label(message, systemImage: kind.systemImage)
            .font(.system(.footnote))
            .foregroundStyle(kind.color)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// Filled accent action. Used once per form region so the primary path is unmistakable.
struct SettingsPrimaryButton: View {
    let title: String
    let loadingTitle: String
    let isLoading: Bool
    let isDisabled: Bool
    var systemImage = "arrow.right"
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
                    .font(.system(.subheadline, weight: .semibold))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                if !isLoading {
                    Image(systemName: systemImage)
                        .font(.system(.footnote, weight: .bold))
                        .accessibilityHidden(true)
                }
            }
            .padding(.horizontal, 16)
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
                .font(.system(.subheadline, weight: .semibold))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(isDisabled ? foreground.opacity(0.55) : foreground)
                .padding(.horizontal, 14)
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
        font(.system(.footnote))
            .foregroundStyle(UnfiledTheme.fog)
            .fixedSize(horizontal: false, vertical: true)
    }
}
