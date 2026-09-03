import AVFoundation
import Foundation

/// Why a recording did not happen, in the owner's terms.
enum VoiceRecorderFailure: Equatable, Sendable {
    case microphoneDenied
    case speechDenied
    case tooShort
    case recordingFailed

    /// Whether the fix lives in Settings rather than in the app.
    var offersSettings: Bool {
        switch self {
        case .microphoneDenied, .speechDenied: true
        case .tooShort, .recordingFailed: false
        }
    }
}

/// The recorder's one visible state at a time.
enum VoiceRecorderPhase: Equatable, Sendable {
    case idle
    case recording(startedAt: Date)
    case stopped(duration: TimeInterval)
    case transcribing(duration: TimeInterval)
    case ready(transcript: String, duration: TimeInterval)
    case failed(VoiceRecorderFailure)

    var isRecording: Bool {
        if case .recording = self { return true }
        return false
    }
}

enum VoiceRecorderEvent: Equatable, Sendable {
    case tapRecord
    case tapStop
    case tick
    case beginTranscription
    case transcript(String)
    case transcriptionFailed
    case microphoneDenied
    case speechDenied
    case recorderFailed
    case reset
}

enum VoiceRecorderRules {
    static let maximumDuration: TimeInterval = 120
    static let minimumDuration: TimeInterval = 0.5
    static let limitWarningAt: TimeInterval = 105

    /// AAC mono at a speech bit rate: two minutes stay well under the attachment cap.
    static var recordingSettings: [String: Any] {
        [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 24_000,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 32_000,
        AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
        ]
    }

    static func nearsLimit(duration: TimeInterval) -> Bool {
        duration >= limitWarningAt
    }

    static func timerLabel(duration: TimeInterval) -> String {
        let whole = max(0, Int(duration.rounded(.down)))
        return "\(whole / 60):" + String(format: "%02d", whole % 60)
    }

    static func copy(for failure: VoiceRecorderFailure) -> String {
        switch failure {
        case .microphoneDenied:
            "Unfiled needs the microphone to record. Allow it in Settings."
        case .speechDenied:
            "Unfiled needs speech recognition to write down what you say. Allow it in Settings, or send the recording as it is."
        case .tooShort:
            "That was too short to keep. Hold on a moment longer."
        case .recordingFailed:
            "The recording stopped unexpectedly. Try again."
        }
    }
}

/// A pure reducer: the recorder's phase after one event, so every transition is testable
/// without a microphone.
enum VoiceRecorderMachine {
    static func apply(_ event: VoiceRecorderEvent, to phase: VoiceRecorderPhase, now: Date) -> VoiceRecorderPhase {
        switch (event, phase) {
        case (.reset, _):
            return .idle
        case (.microphoneDenied, _):
            return .failed(.microphoneDenied)
        case (.speechDenied, _):
            return .failed(.speechDenied)
        case (.recorderFailed, _):
            return .failed(.recordingFailed)
        case (.tapRecord, .idle), (.tapRecord, .failed):
            return .recording(startedAt: now)
        case let (.tapStop, .recording(startedAt)):
            let elapsed = (now.timeIntervalSince(startedAt) * 1000).rounded() / 1000
            let duration = min(elapsed, VoiceRecorderRules.maximumDuration)
            return duration < VoiceRecorderRules.minimumDuration ? .failed(.tooShort) : .stopped(duration: duration)
        case let (.tick, .recording(startedAt)):
            return now.timeIntervalSince(startedAt) >= VoiceRecorderRules.maximumDuration
                ? .stopped(duration: VoiceRecorderRules.maximumDuration)
                : phase
        case let (.beginTranscription, .stopped(duration)):
            return .transcribing(duration: duration)
        case let (.transcript(text), .transcribing(duration)):
            return .ready(transcript: text.trimmingCharacters(in: .whitespacesAndNewlines), duration: duration)
        case let (.transcriptionFailed, .transcribing(duration)):
            return .ready(transcript: "", duration: duration)
        default:
            return phase
        }
    }
}
