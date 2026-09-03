import SwiftUI

/// Paper: a cool light ground, ink text, one deep green for state and the primary action.
/// Token names are roles, not colors: `ink` is the ground the screens sit on, `paper` is the
/// text that sits on it, `persimmon` is the single accent. (Historic names; the roles are what
/// every screen depends on.)
enum UnfiledTheme {
    /// Screen ground.
    static let ink = Color(red: 243 / 255, green: 244 / 255, blue: 246 / 255)
    /// Surfaces that sit on the ground: fields, cards, the dock.
    static let graphite = Color.white
    /// Pressed and secondary controls.
    static let raised = Color(red: 230 / 255, green: 232 / 255, blue: 236 / 255)
    /// Primary text.
    static let paper = Color(red: 20 / 255, green: 23 / 255, blue: 27 / 255)
    /// The one accent: state dots, the capture button, links.
    static let persimmon = Color(red: 30 / 255, green: 107 / 255, blue: 87 / 255)
    /// Secondary text.
    static let fog = Color(red: 98 / 255, green: 107 / 255, blue: 118 / 255)
    /// Hairlines.
    static let border = Color(red: 221 / 255, green: 225 / 255, blue: 230 / 255)

    static let screenPadding: CGFloat = 22
    static let controlRadius: CGFloat = 13
    static let controlStackSpacing: CGFloat = 12
    static let formActionSpacing: CGFloat = 18
    static let minimumTouchTarget: CGFloat = 44
    /// Space between a screen header and its first section on every tab.
    static let sectionTop: CGFloat = 32
    /// Space between a pushed screen's navigation bar and its header; the bar already breathes.
    static let pushedHeaderTop: CGFloat = 16
    /// Space between a pushed screen's header block and the rule or content beneath it.
    static let headerBottom: CGFloat = 24
    /// Space between an eyebrow and the display title under it.
    static let eyebrowToTitle: CGFloat = 8
    /// Space between a section label and the hairline or first row beneath it.
    static let labelToRule: CGFloat = 14
    /// Vertical padding for any block that sits between hairlines: list rows and detail sections.
    static let rowVertical: CGFloat = 22
    /// Gap between sibling controls: chips, paired buttons, option cards.
    static let controlGap: CGFloat = 10
    /// Inner padding of a card or callout surface.
    static let cardPadding: CGFloat = 16
    /// Horizontal inset for text inside fields, pickers, and filled buttons.
    static let fieldPadding: CGFloat = 16
    /// Minimum height of a full-width control: primary buttons, text fields, pickers.
    static let controlHeight: CGFloat = 52
    /// Bottom scroll inset under a floating bar: the tab dock or a sheet's submit bar.
    static let screenBottom: CGFloat = 110
    /// Bottom scroll inset on pushed screens, which have no floating bar.
    static let pushedScreenBottom: CGFloat = 48
}

/// The single type scale. Every screen uses these seven roles and nothing else, so the
/// app reads as one voice: text styles keep Dynamic Type, and thoughts are set in the
/// reading face rather than monospace.
enum UnfiledType {
    /// One per screen: the screen title, in the serif.
    static let display = Font.system(.largeTitle, design: .serif, weight: .semibold)
    /// Section and row titles, in the serif.
    static let title = Font.system(.title2, design: .serif, weight: .semibold)
    /// Thoughts and note text: writing, so it reads in the serif.
    static let thought = Font.system(.body, design: .serif)
    /// Emphasized body: headlines inside rows, primary buttons.
    static let heading = Font.system(.body, weight: .semibold)
    /// Reading text: thoughts, notes, descriptions.
    static let body = Font.system(.body)
    /// Supporting text next to body.
    static let secondary = Font.system(.subheadline)
    static let secondaryStrong = Font.system(.subheadline, weight: .semibold)
    /// Metadata: times, counts, states.
    static let caption = Font.system(.footnote, weight: .medium)
    /// Uppercase section labels.
    static let label = Font.system(.caption, weight: .semibold)
    /// The composer's writing size, in the serif.
    static let composer = Font.system(.title3, design: .serif, weight: .regular)
    static let displayTracking: CGFloat = -0.6
    static let labelTracking: CGFloat = 0.9
}

extension View {
    func unfiledScreen() -> some View {
        foregroundStyle(UnfiledTheme.paper)
            .background(UnfiledTheme.ink.ignoresSafeArea())
            .tint(UnfiledTheme.persimmon)
            .preferredColorScheme(.light)
    }
}

struct SectionRule: View {
    var body: some View {
        Rectangle()
            .fill(UnfiledTheme.border)
            .frame(height: 1)
            .accessibilityHidden(true)
    }
}

/// Uppercase section label. Sans, not monospace: labels are wayfinding, not code.
struct EditorialEyebrow: View {
    let text: String

    var body: some View {
        Text(text.uppercased())
            .font(UnfiledType.label)
            .tracking(UnfiledType.labelTracking)
            .foregroundStyle(UnfiledTheme.fog)
    }
}

/// The one screen header: the mark and an optional trailing control on the top row, then the
/// title and an optional one-line subtitle. The mark appears here, once per screen, and never
/// inside content or empty states. Pushed screens with a back button pass `showsMark: false`.
struct ScreenHeader<Trailing: View>: View {
    let title: String
    var subtitle: String?
    var showsMark = true
    @ViewBuilder let trailing: () -> Trailing

    init(
        title: String,
        subtitle: String? = nil,
        showsMark: Bool = true,
        @ViewBuilder trailing: @escaping () -> Trailing
    ) {
        self.title = title
        self.subtitle = subtitle
        self.showsMark = showsMark
        self.trailing = trailing
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if showsTopRow {
                HStack(alignment: .center, spacing: 12) {
                    if showsMark {
                        UnfiledMark(size: 28)
                    }
                    Spacer(minLength: 12)
                    trailing()
                }
                .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            }
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(UnfiledType.display)
                    .tracking(UnfiledType.displayTracking)
                    .accessibilityAddTraits(.isHeader)
                if let subtitle {
                    Text(subtitle)
                        .font(UnfiledType.secondary)
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.top, showsMark ? 4 : UnfiledTheme.pushedHeaderTop)
    }

    /// Pushed screens hide the mark and rarely add a trailing control, so the row that would
    /// hold them is dropped instead of leaving 44 points of empty space under the navigation bar.
    private var showsTopRow: Bool {
        showsMark || Trailing.self != EmptyView.self
    }
}

extension ScreenHeader where Trailing == EmptyView {
    init(title: String, subtitle: String? = nil, showsMark: Bool = true) {
        self.init(title: title, subtitle: subtitle, showsMark: showsMark) { EmptyView() }
    }
}

/// A 44-point circular glyph button used for every secondary screen action.
struct IconButton: View {
    let glyph: UnfiledGlyph
    let label: String
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            GlyphView(glyph: glyph, size: 20, weight: 1.9)
                .foregroundStyle(UnfiledTheme.paper)
                .frame(width: UnfiledTheme.minimumTouchTarget, height: UnfiledTheme.minimumTouchTarget)
                .background(UnfiledTheme.graphite)
                .clipShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

/// A selectable pill. Rows of chips replace segmented controls and radio cards.
struct Chip: View {
    let title: String
    let selected: Bool
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(UnfiledType.caption)
                .foregroundStyle(selected ? UnfiledTheme.ink : UnfiledTheme.paper)
                .padding(.horizontal, 14)
                .frame(minHeight: 36)
                .background(selected ? UnfiledTheme.paper : UnfiledTheme.graphite)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}

/// A small state indicator that reads before the label.
struct StatusDot: View {
    let color: Color

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 7, height: 7)
            .accessibilityHidden(true)
    }
}

struct PrimaryActionButton: View {
    let title: String
    var systemImage: String?
    var disabled = false
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                if let systemImage {
                    Image(systemName: systemImage)
                        .font(.system(size: 15, weight: .semibold))
                }
                Text(title)
                    .font(UnfiledType.heading)
            }
            .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
            .foregroundStyle(UnfiledTheme.ink)
            .background(disabled ? UnfiledTheme.fog : UnfiledTheme.persimmon)
            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .accessibilityAddTraits(.isButton)
    }
}

/// An empty state is a sentence and, at most, one action. Never an illustration or a logo.
struct EmptyLedgerView: View {
    let title: String
    let message: String
    var actionTitle: String?
    var action: (@MainActor () -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(UnfiledType.title)
            Text(message)
                .font(UnfiledType.secondary)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(UnfiledType.heading)
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                    .padding(.top, 4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 28)
    }
}
