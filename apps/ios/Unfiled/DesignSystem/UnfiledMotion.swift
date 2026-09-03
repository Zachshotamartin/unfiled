import SwiftUI
import UIKit

/// The app's motion system. Every animation, transition, press effect, and haptic in the app
/// comes from here, so motion feels like one hand: springs that settle, a card that drops into
/// the tray, and feedback you can feel. Reduce Motion is honored at the definition.
@MainActor
enum UnfiledMotion {
    /// Small state changes: selection, press, chips.
    static let quick = Animation.spring(response: 0.28, dampingFraction: 0.82)
    /// Content moving: tab content, rows appearing, cards settling.
    static let settle = Animation.spring(response: 0.42, dampingFraction: 0.84)
    /// One emphasized moment: a card landing, a save.
    static let emphasis = Animation.spring(response: 0.55, dampingFraction: 0.68)

    /// The animation to use for a change, or none under Reduce Motion.
    static func animation(_ animation: Animation) -> Animation? {
        UIAccessibility.isReduceMotionEnabled ? nil : animation
    }

    /// Tab content: a crossfade with a short vertical settle, so a switch reads as the page
    /// arriving rather than a hard cut.
    static var page: AnyTransition {
        UIAccessibility.isReduceMotionEnabled
            ? .opacity
            : .asymmetric(
                insertion: .opacity.combined(with: .offset(y: 14)),
                removal: .opacity
            )
    }

    /// Something rising into view: the Library handing itself to search, a card landing.
    static var rise: AnyTransition {
        UIAccessibility.isReduceMotionEnabled
            ? .opacity
            : .opacity.combined(with: .offset(y: 24)).combined(with: .scale(scale: 0.98, anchor: .top))
    }

    /// The bubble behind the selected tab: it pops in place under the new tab and fades under the
    /// old one, so it never travels across the capture button.
    static var bubble: AnyTransition {
        UIAccessibility.isReduceMotionEnabled
            ? .opacity
            : .scale(scale: 0.82).combined(with: .opacity)
    }

    /// A row arriving in a list.
    static var row: AnyTransition {
        UIAccessibility.isReduceMotionEnabled
            ? .opacity
            : .opacity.combined(with: .offset(y: 10))
    }
}

/// Feedback you can feel. One event per meaning; never a raw generator at a call site.
@MainActor
enum UnfiledHaptics {
    static func tap() {
        UIImpactFeedbackGenerator(style: .light).impactOccurred()
    }

    static func selection() {
        UISelectionFeedbackGenerator().selectionChanged()
    }

    static func saved() {
        UINotificationFeedbackGenerator().notificationOccurred(.success)
    }

    static func warning() {
        UINotificationFeedbackGenerator().notificationOccurred(.warning)
    }
}

/// The one press effect: a slight scale and dim on a quick spring. Used by every tappable
/// card, chip, icon button, and tab.
struct UnfiledPressStyle: ButtonStyle {
    var scale: CGFloat = 0.97

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? scale : 1)
            .opacity(configuration.isPressed ? 0.86 : 1)
            .animation(UnfiledMotion.animation(UnfiledMotion.quick), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == UnfiledPressStyle {
    static var unfiledPress: UnfiledPressStyle { UnfiledPressStyle() }
}

/// A glyph nudge: the card drops into place when its trigger changes (a tab becomes selected,
/// a save lands). One definition for every glyph that reacts.
struct GlyphNudge<Trigger: Equatable>: ViewModifier {
    let trigger: Trigger
    @State private var lifted = false

    func body(content: Content) -> some View {
        content
            .offset(y: lifted ? -4 : 0)
            .scaleEffect(lifted ? 1.08 : 1)
            .onChange(of: trigger) { _, _ in
                guard !UIAccessibility.isReduceMotionEnabled else { return }
                withAnimation(UnfiledMotion.quick) { lifted = true }
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(110))
                    withAnimation(UnfiledMotion.emphasis) { lifted = false }
                }
            }
    }
}

extension View {
    func glyphNudge<Trigger: Equatable>(on trigger: Trigger) -> some View {
        modifier(GlyphNudge(trigger: trigger))
    }
}

/// Loading is the mark at work: a card drops into the tray, again and again. Replaces every
/// spinner on the main screens, inline (small) or as a block.
struct UnfiledLoadingView: View {
    var size: CGFloat = 20
    var label: String = "Loading"

    var body: some View {
        Group {
            if UIAccessibility.isReduceMotionEnabled {
                LoadingFrame(progress: 1, size: size)
            } else {
                TimelineView(.animation(minimumInterval: 1 / 60)) { context in
                    let cycle = 1.15
                    let time = context.date.timeIntervalSinceReferenceDate
                    let progress = (time.truncatingRemainder(dividingBy: cycle)) / cycle
                    LoadingFrame(progress: progress, size: size)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel(label)
    }
}

/// One frame of the loading mark: the tray stays; the card falls from above, lands, and fades.
private struct LoadingFrame: View {
    let progress: Double
    let size: CGFloat

    var body: some View {
        let unit = size / 24
        // Ease the drop, hold at the bottom, then fade out before the next card.
        let drop = min(1, progress / 0.55)
        let eased = 1 - pow(1 - drop, 3)
        let fade = progress > 0.8 ? 1 - (progress - 0.8) / 0.2 : 1
        ZStack {
            GlyphStroke(glyph: .organize)
                .stroke(style: StrokeStyle(lineWidth: 2.3, lineCap: .square, lineJoin: .round))
                .frame(width: size, height: size)
            GlyphFill(glyph: .organize)
                .fill()
                .frame(width: size, height: size)
                .offset(y: (-7 + 7 * eased) * unit)
                .opacity(fade)
        }
        .foregroundStyle(UnfiledTheme.persimmon)
    }
}
