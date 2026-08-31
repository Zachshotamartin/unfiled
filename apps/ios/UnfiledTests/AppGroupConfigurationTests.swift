import Foundation
import XCTest
@testable import Unfiled

final class AppGroupConfigurationTests: XCTestCase {
    func testQuickCaptureSignalIsDurableAndConsumedExactlyOnce() throws {
        let suite = "unfiled-app-group-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        XCTAssertFalse(AppGroupConfiguration.consumeQuickCaptureSignal(in: defaults))
        AppGroupConfiguration.signalQuickCapture(in: defaults)
        XCTAssertNotNil(defaults.string(forKey: AppGroupConfiguration.quickCaptureIntentKey))
        XCTAssertTrue(AppGroupConfiguration.consumeQuickCaptureSignal(in: defaults))
        XCTAssertFalse(AppGroupConfiguration.consumeQuickCaptureSignal(in: defaults))
    }

    func testQuickCaptureURLRequiresExactNonAmbiguousShape() throws {
        let valid = try XCTUnwrap(
            URL(string: "unfiled-dev://capture?source=ios_lock_screen_widget")
        )
        XCTAssertTrue(
            AppGroupConfiguration.isValidQuickCaptureURL(
                valid,
                expectedScheme: "unfiled-dev"
            )
        )

        for invalidValue in [
            "unfiled-dev://capture",
            "unfiled-dev://capture/anything?source=ios_lock_screen_widget",
            "unfiled-dev://capture?source=mobile",
            "unfiled-dev://capture?source=ios_lock_screen_widget&source=mobile",
            "unfiled-dev://capture?source=ios_lock_screen_widget&note=secret",
            "unfiled-dev://user@capture?source=ios_lock_screen_widget",
            "unfiled-dev://capture:443?source=ios_lock_screen_widget",
            "unfiled-dev://capture?source=ios_lock_screen_widget#fragment",
            "other://capture?source=ios_lock_screen_widget"
        ] {
            let invalid = try XCTUnwrap(URL(string: invalidValue))
            XCTAssertFalse(
                AppGroupConfiguration.isValidQuickCaptureURL(
                    invalid,
                    expectedScheme: "unfiled-dev"
                ),
                invalidValue
            )
        }
    }
}
