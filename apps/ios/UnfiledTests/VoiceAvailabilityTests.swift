import Speech
import XCTest
@testable import Unfiled

/// Recording is offered only where the words can be written down on this phone. Nothing else
/// writes them down: Claude accepts no audio, so a phone without on-device recognition would
/// leave the owner with a recording nobody can read.
final class VoiceAvailabilityTests: XCTestCase {
    func testOffersRecordingOnlyWhenThePhoneCanWriteItDown() {
        XCTAssertTrue(
            VoiceAvailability.canRecord(
                recognizerExists: true,
                recognizerAvailable: true,
                supportsOnDeviceRecognition: true,
                authorization: .authorized
            )
        )
        XCTAssertTrue(
            VoiceAvailability.canRecord(
                recognizerExists: true,
                recognizerAvailable: true,
                supportsOnDeviceRecognition: true,
                authorization: .notDetermined
            ),
            "permission is asked for at the first recording, not before the control appears"
        )
    }

    func testRefusesWithoutAnOnDeviceModelOrARecognizer() {
        XCTAssertFalse(
            VoiceAvailability.canRecord(
                recognizerExists: true,
                recognizerAvailable: true,
                supportsOnDeviceRecognition: false,
                authorization: .authorized
            ),
            "recognition that would leave the phone is never used"
        )
        XCTAssertFalse(
            VoiceAvailability.canRecord(
                recognizerExists: false,
                recognizerAvailable: false,
                supportsOnDeviceRecognition: false,
                authorization: .authorized
            )
        )
        XCTAssertFalse(
            VoiceAvailability.canRecord(
                recognizerExists: true,
                recognizerAvailable: false,
                supportsOnDeviceRecognition: true,
                authorization: .authorized
            ),
            "a language still downloading is not an engine yet"
        )
    }

    func testRefusesWhenTheOwnerTurnedSpeechRecognitionOff() {
        for status in [
            SFSpeechRecognizerAuthorizationStatus.denied,
            SFSpeechRecognizerAuthorizationStatus.restricted
        ] {
            XCTAssertFalse(
                VoiceAvailability.canRecord(
                    recognizerExists: true,
                    recognizerAvailable: true,
                    supportsOnDeviceRecognition: true,
                    authorization: status
                ),
                "\(status) leaves nothing to write the words down"
            )
        }
    }
}
