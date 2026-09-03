import Foundation
import Speech

enum SpeechTranscriptionError: Error, Equatable {
    case denied
    case unavailable
    case failed
}

protocol SpeechTranscribing: Sendable {
    func transcribe(fileURL: URL) async throws -> String
}

/// Writes down a recording on the phone itself. Recognition that would leave the device is
/// refused: a phone or language without an on-device model keeps the recording and says so.
struct OnDeviceSpeechTranscriber: SpeechTranscribing {
    func transcribe(fileURL: URL) async throws -> String {
        let status = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard status == .authorized else { throw SpeechTranscriptionError.denied }
        guard let recognizer = SFSpeechRecognizer(locale: .current) ?? SFSpeechRecognizer(),
              recognizer.isAvailable, recognizer.supportsOnDeviceRecognition else {
            throw SpeechTranscriptionError.unavailable
        }
        let request = SFSpeechURLRecognitionRequest(url: fileURL)
        request.requiresOnDeviceRecognition = true
        request.shouldReportPartialResults = false
        request.addsPunctuation = true
        return try await withCheckedThrowingContinuation { continuation in
            let settled = SettledFlag()
            recognizer.recognitionTask(with: request) { result, error in
                guard settled.claim() else { return }
                if let result, result.isFinal || error == nil {
                    continuation.resume(returning: result.bestTranscription.formattedString)
                } else {
                    continuation.resume(throwing: SpeechTranscriptionError.failed)
                }
            }
        }
    }
}

/// Lets exactly one recognition callback settle the continuation.
private final class SettledFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var settled = false

    func claim() -> Bool {
        lock.withLock {
            guard !settled else { return false }
            settled = true
            return true
        }
    }
}
