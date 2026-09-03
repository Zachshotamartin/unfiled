import Foundation
import Speech

/// Whether this phone can write down what the owner says. Recording is only offered when it can:
/// a recording nobody can turn into words would leave the owner with a note they cannot read,
/// and no provider fills the gap (Claude accepts no audio at all).
enum VoiceAvailability {
    /// The rule, over the three facts that decide it, so it can be checked without a microphone.
    static func canRecord(
        recognizerExists: Bool,
        recognizerAvailable: Bool,
        supportsOnDeviceRecognition: Bool,
        authorization: SFSpeechRecognizerAuthorizationStatus
    ) -> Bool {
        guard recognizerExists, recognizerAvailable, supportsOnDeviceRecognition else { return false }
        switch authorization {
        case .denied, .restricted: return false
        case .authorized, .notDetermined: return true
        @unknown default: return false
        }
    }

    /// The same rule against this phone, in this language, right now.
    static func canRecordOnThisPhone(locale: Locale = .current) -> Bool {
        let recognizer = SFSpeechRecognizer(locale: locale) ?? SFSpeechRecognizer()
        return canRecord(
            recognizerExists: recognizer != nil,
            recognizerAvailable: recognizer?.isAvailable ?? false,
            supportsOnDeviceRecognition: recognizer?.supportsOnDeviceRecognition ?? false,
            authorization: SFSpeechRecognizer.authorizationStatus()
        )
    }
}
