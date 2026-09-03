import AVFoundation
import Foundation
import XCTest
@testable import Unfiled

/// The recorder's states and the rules around them: one tap starts, one tap stops, the limit
/// stops it for you, a transcript makes it ready, and a failed transcript still keeps the recording.
final class VoiceRecorderMachineTests: XCTestCase {
    private let start = Date(timeIntervalSince1970: 1_000)

    func testOneTapStartsAndOneTapStopsWithTheDuration() {
        var phase = VoiceRecorderPhase.idle
        phase = VoiceRecorderMachine.apply(.tapRecord, to: phase, now: start)
        XCTAssertEqual(phase, .recording(startedAt: start))
        phase = VoiceRecorderMachine.apply(.tapStop, to: phase, now: start.addingTimeInterval(12.4))
        XCTAssertEqual(phase, .stopped(duration: 12.4))
    }

    func testTooShortRecordingsAreRefusedAndTheLimitStopsForYou() {
        let recording = VoiceRecorderPhase.recording(startedAt: start)
        XCTAssertEqual(
            VoiceRecorderMachine.apply(.tapStop, to: recording, now: start.addingTimeInterval(0.2)),
            .failed(.tooShort)
        )
        XCTAssertEqual(
            VoiceRecorderMachine.apply(.tick, to: recording, now: start.addingTimeInterval(119)),
            recording
        )
        XCTAssertEqual(
            VoiceRecorderMachine.apply(.tick, to: recording, now: start.addingTimeInterval(120.5)),
            .stopped(duration: VoiceRecorderRules.maximumDuration)
        )
        XCTAssertFalse(VoiceRecorderRules.nearsLimit(duration: 90))
        XCTAssertTrue(VoiceRecorderRules.nearsLimit(duration: 106))
    }

    func testTranscriptMakesTheRecordingReadyAndAFailedTranscriptKeepsIt() {
        var phase = VoiceRecorderPhase.stopped(duration: 8)
        phase = VoiceRecorderMachine.apply(.beginTranscription, to: phase, now: start)
        XCTAssertEqual(phase, .transcribing(duration: 8))
        XCTAssertEqual(
            VoiceRecorderMachine.apply(.transcript("  Buy oat milk tomorrow  "), to: phase, now: start),
            .ready(transcript: "Buy oat milk tomorrow", duration: 8)
        )
        XCTAssertEqual(
            VoiceRecorderMachine.apply(.transcript("   "), to: phase, now: start),
            .ready(transcript: "", duration: 8)
        )
        XCTAssertEqual(
            VoiceRecorderMachine.apply(.transcriptionFailed, to: phase, now: start),
            .ready(transcript: "", duration: 8)
        )
    }

    func testPermissionAndRecorderFailuresNameThemselves() {
        XCTAssertEqual(
            VoiceRecorderMachine.apply(.microphoneDenied, to: .idle, now: start),
            .failed(.microphoneDenied)
        )
        XCTAssertEqual(
            VoiceRecorderMachine.apply(.recorderFailed, to: .recording(startedAt: start), now: start),
            .failed(.recordingFailed)
        )
        XCTAssertEqual(VoiceRecorderMachine.apply(.reset, to: .failed(.tooShort), now: start), .idle)
        XCTAssertTrue(VoiceRecorderRules.copy(for: .microphoneDenied).contains("Settings"))
        XCTAssertTrue(VoiceRecorderRules.copy(for: .tooShort).contains("short"))
        XCTAssertTrue(VoiceRecorderFailure.microphoneDenied.offersSettings)
        XCTAssertFalse(VoiceRecorderFailure.tooShort.offersSettings)
    }

    func testTimerLabelReadsLikeAClock() {
        XCTAssertEqual(VoiceRecorderRules.timerLabel(duration: 0), "0:00")
        XCTAssertEqual(VoiceRecorderRules.timerLabel(duration: 7.9), "0:07")
        XCTAssertEqual(VoiceRecorderRules.timerLabel(duration: 65), "1:05")
        XCTAssertEqual(VoiceRecorderRules.timerLabel(duration: 120), "2:00")
    }

    func testRecordingSettingsStayUnderTheAttachmentCap() {
        let settings = VoiceRecorderRules.recordingSettings
        XCTAssertEqual(settings[AVNumberOfChannelsKey] as? Int, 1)
        let bitRate = settings[AVEncoderBitRateKey] as? Int ?? 0
        XCTAssertLessThanOrEqual(bitRate / 8 * Int(VoiceRecorderRules.maximumDuration), 700_000)
    }
}
