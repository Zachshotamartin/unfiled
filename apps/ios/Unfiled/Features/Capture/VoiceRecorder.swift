import AVFoundation
import Foundation

enum VoiceRecorderError: Error {
    case startFailed
}

/// Records one voice note as AAC into a protected temporary file. The composer reads the bytes
/// into the encrypted outbox and removes the file; nothing lingers on disk.
@MainActor
final class VoiceRecorder: NSObject, AVAudioRecorderDelegate {
    private var recorder: AVAudioRecorder?
    private(set) var fileURL: URL?

    func requestPermission() async -> Bool {
        await AVAudioApplication.requestRecordPermission()
    }

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .spokenAudio, options: [.duckOthers])
        try session.setActive(true)
        let url = FileManager.default.temporaryDirectory.appending(
            path: "voice-\(UUID().uuidString).m4a", directoryHint: .notDirectory
        )
        let recorder = try AVAudioRecorder(url: url, settings: VoiceRecorderRules.recordingSettings)
        recorder.delegate = self
        guard recorder.record() else { throw VoiceRecorderError.startFailed }
        try? FileManager.default.setAttributes(
            [.protectionKey: FileProtectionType.complete], ofItemAtPath: url.path
        )
        self.recorder = recorder
        fileURL = url
    }

    /// Stops and hands back the file and its length; nil when nothing was recording.
    func stop() -> (url: URL, duration: TimeInterval)? {
        guard let recorder, let fileURL else { return nil }
        let duration = recorder.currentTime
        recorder.stop()
        self.recorder = nil
        self.fileURL = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        return (fileURL, duration)
    }

    func discard() {
        recorder?.stop()
        recorder = nil
        if let fileURL { try? FileManager.default.removeItem(at: fileURL) }
        fileURL = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
}
