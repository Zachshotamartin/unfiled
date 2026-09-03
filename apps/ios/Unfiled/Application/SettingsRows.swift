import SwiftUI

/// A labeled group of rows: the eyebrow, a rule, then rows that each close with a rule.
struct SettingsGroup<Content: View>: View {
    let label: String
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            EditorialEyebrow(text: label)
                .accessibilityAddTraits(.isHeader)
                .padding(.bottom, UnfiledTheme.labelToRule)
            SectionRule()
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The frame every settings row shares: 52 points tall, full width, closed by a hairline.
private struct SettingsRowFrame: ViewModifier {
    func body(content: Content) -> some View {
        content
            .padding(.vertical, AISettingsControlLayout.rowVerticalPadding)
            .frame(
                maxWidth: .infinity,
                minHeight: AISettingsControlLayout.rowMinimumHeight,
                alignment: .leading
            )
            .contentShape(Rectangle())
            .overlay(alignment: .bottom) { SectionRule() }
    }
}

extension View {
    func settingsRow() -> some View {
        modifier(SettingsRowFrame())
    }

    /// A taller block between hairlines: a field with its help, or a message with its actions.
    func settingsBlock() -> some View {
        padding(.vertical, UnfiledTheme.rowVertical)
            .frame(maxWidth: .infinity, alignment: .leading)
            .overlay(alignment: .bottom) { SectionRule() }
    }

    @ViewBuilder
    func settingsAccessibilityIdentifier(_ identifier: String?) -> some View {
        if let identifier {
            accessibilityIdentifier(identifier)
        } else {
            self
        }
    }
}

/// A row that pushes a page: the title, its current value on the right, and a chevron.
struct SettingsNavigationRow: View {
    let title: String
    var value: String?
    var accessibilityHint: String?
    var accessibilityIdentifier: String?
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: AISettingsControlLayout.rowValueSpacing) {
                Text(title)
                    .font(UnfiledType.body)
                    .foregroundStyle(UnfiledTheme.paper)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if let value {
                    Text(value)
                        .font(UnfiledType.secondary)
                        .foregroundStyle(UnfiledTheme.fog)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                GlyphView(glyph: .chevron, size: 16, weight: 1.8)
                    .foregroundStyle(UnfiledTheme.fog)
            }
            .settingsRow()
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(value ?? "")
        .accessibilityHint(accessibilityHint ?? "Opens \(title.lowercased())")
        .settingsAccessibilityIdentifier(accessibilityIdentifier)
    }
}

/// A read-only row: a label on the left and its value on the right.
struct SettingsInfoRow: View {
    let title: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: AISettingsControlLayout.rowValueSpacing) {
            Text(title)
                .font(UnfiledType.body)
                .foregroundStyle(UnfiledTheme.paper)
            Spacer(minLength: 12)
            Text(value)
                .font(UnfiledType.secondary)
                .foregroundStyle(UnfiledTheme.fog)
                .multilineTextAlignment(.trailing)
        }
        .settingsRow()
        .accessibilityElement(children: .combine)
    }
}

/// A single sentence between hairlines, led by a glyph: facts about this phone.
struct SettingsNoteRow: View {
    let glyph: UnfiledGlyph
    let text: String

    var body: some View {
        Label {
            Text(text)
                .font(UnfiledType.secondary)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            GlyphView(glyph: glyph, size: 16, weight: 1.7)
                .foregroundStyle(UnfiledTheme.fog)
        }
        .settingsRow()
        .accessibilityElement(children: .combine)
    }
}

/// A row that acts in place: sign out, export, delete. Accent rows carry the one accent color.
struct SettingsButtonRow: View {
    enum Emphasis {
        case neutral, accent
    }

    let title: String
    var glyph: UnfiledGlyph?
    var emphasis: Emphasis = .neutral
    var isBusy = false
    var isDisabled = false
    var accessibilityHint: String?
    var accessibilityIdentifier: String?
    let action: @MainActor () -> Void

    private var color: Color {
        emphasis == .accent ? UnfiledTheme.persimmon : UnfiledTheme.paper
    }

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: AISettingsControlLayout.rowValueSpacing) {
                Text(title)
                    .font(UnfiledType.body)
                    .foregroundStyle(color)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if isBusy {
                    ProgressView()
                        .tint(color)
                        .accessibilityHidden(true)
                } else if let glyph {
                    GlyphView(glyph: glyph, size: 16, weight: 1.8)
                        .foregroundStyle(color)
                }
            }
            .settingsRow()
            .opacity(isDisabled ? 0.55 : 1)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled || isBusy)
        .accessibilityValue(isBusy ? "In progress" : "")
        .accessibilityHint(accessibilityHint ?? "")
        .settingsAccessibilityIdentifier(accessibilityIdentifier)
    }
}

/// A selectable row on a choice page: the title, one line of detail, and a check when selected.
struct SettingsChoiceRow: View {
    let title: String
    let detail: String?
    let isSelected: Bool
    var isDisabled = false
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            HStack(alignment: .center, spacing: AISettingsControlLayout.rowValueSpacing) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(UnfiledType.body)
                        .foregroundStyle(UnfiledTheme.paper)
                    if let detail {
                        Text(detail)
                            .font(UnfiledType.secondary)
                            .foregroundStyle(UnfiledTheme.fog)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if isSelected {
                    GlyphView(glyph: .check, size: 18, weight: 2.1)
                        .foregroundStyle(UnfiledTheme.persimmon)
                }
            }
            .settingsRow()
            .opacity(isDisabled ? 0.55 : 1)
        }
        .buttonStyle(.plain)
        .disabled(isDisabled)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(isSelected ? "Selected" : "Not selected")
        .accessibilityHint(detail ?? "")
        .accessibilityAddTraits(isSelected ? [.isSelected] : [])
    }
}
