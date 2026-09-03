import SwiftUI

/// The one control for voice: a microphone to start, an unmistakable stop with a running clock
/// while recording, a plain line while the words are written down, and a plain line when
/// something stops it, with a way to Settings when that is where the fix lives.
struct VoiceRecorderControl: View {
    let phase: VoiceRecorderPhase
    let onTapRecord: @MainActor () -> Void
    let onTapStop: @MainActor () -> Void
    let onOpenSettings: @MainActor () -> Void
    let onDismissFailure: @MainActor () -> Void

    var body: some View {
        switch phase {
        case .idle, .stopped, .ready:
            // The same circle as the photo control beside it, so the row reads as one set.
            Button(action: onTapRecord) {
                GlyphView(glyph: .microphone, size: 20, weight: 1.9)
                    .foregroundStyle(UnfiledTheme.paper)
                    .frame(
                        width: UnfiledTheme.minimumTouchTarget,
                        height: UnfiledTheme.minimumTouchTarget
                    )
                    .background(UnfiledTheme.raised)
                    .clipShape(Circle())
            }
            .buttonStyle(.unfiledPress)
            .accessibilityLabel("Record a voice note")
            .accessibilityIdentifier("capture.record")
        case let .recording(startedAt):
            TimelineView(.periodic(from: startedAt, by: 1)) { context in
                let duration = context.date.timeIntervalSince(startedAt)
                HStack(spacing: 10) {
                    Circle()
                        .fill(UnfiledTheme.persimmon)
                        .frame(width: 10, height: 10)
                        .opacity(Int(duration) % 2 == 0 ? 1 : 0.35)
                    Text(VoiceRecorderRules.timerLabel(duration: duration))
                        .font(UnfiledType.caption)
                        .monospacedDigit()
                        .foregroundStyle(
                            VoiceRecorderRules.nearsLimit(duration: duration) ? UnfiledTheme.persimmon : UnfiledTheme.paper
                        )
                    Button(action: onTapStop) {
                        RoundedRectangle(cornerRadius: 3, style: .continuous)
                            .fill(UnfiledTheme.ink)
                            .frame(width: 14, height: 14)
                            .frame(width: UnfiledTheme.minimumTouchTarget, height: UnfiledTheme.minimumTouchTarget)
                            .background(UnfiledTheme.persimmon)
                            .clipShape(Circle())
                    }
                    .buttonStyle(.unfiledPress)
                    .accessibilityLabel("Stop recording")
                    .accessibilityIdentifier("capture.stop-recording")
                }
                .accessibilityElement(children: .contain)
                .accessibilityLabel("Recording, \(VoiceRecorderRules.timerLabel(duration: duration))")
            }
        case .transcribing:
            HStack(spacing: 8) {
                UnfiledLoadingView(size: 16, label: "Writing down what you said")
                Text("Writing down what you said")
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
            }
            .accessibilityIdentifier("capture.transcribing")
        case let .failed(failure):
            HStack(spacing: 10) {
                Text(VoiceRecorderRules.copy(for: failure))
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
                if failure.offersSettings {
                    Button("Settings", action: onOpenSettings)
                        .font(UnfiledType.caption)
                        .foregroundStyle(UnfiledTheme.persimmon)
                }
                Button(action: onDismissFailure) {
                    GlyphView(glyph: .close, size: 12, weight: 2)
                        .foregroundStyle(UnfiledTheme.fog)
                        .frame(width: 32, height: 32)
                }
                .accessibilityLabel("Dismiss")
            }
            .accessibilityIdentifier("capture.record-failure")
        }
    }
}
