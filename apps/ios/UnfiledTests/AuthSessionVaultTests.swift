import Foundation
import XCTest
@testable import Unfiled

final class AuthSessionVaultTests: XCTestCase {
    func testRoundTripUsesThisDeviceOnlyAccessibility() throws {
        let store = AuthMemorySecureDataStore()
        let vault = KeychainSessionVault(store: store, service: "tests", account: "session")
        let expected = authSession()
        try vault.save(expected)
        XCTAssertEqual(try vault.load(), expected)
        guard case .whenUnlockedThisDeviceOnly = store.lastAccessibility else {
            return XCTFail("Session must be bound to this device")
        }
        try vault.clear()
        XCTAssertNil(try vault.load())
    }

    func testCorruptOrOversizedStoredSessionFailsClosed() throws {
        let store = AuthMemorySecureDataStore()
        let vault = KeychainSessionVault(store: store)
        store.seed(Data("not-json".utf8))
        XCTAssertThrowsError(try vault.load()) { XCTAssertEqual($0 as? SessionVaultError, .corruptData) }
        store.seed(Data(repeating: 0, count: KeychainSessionVault.maximumSessionBytes + 1))
        XCTAssertThrowsError(try vault.load()) { XCTAssertEqual($0 as? SessionVaultError, .corruptData) }
    }

    func testStoreErrorsAreRedacted() throws {
        let store = AuthMemorySecureDataStore(); store.writeError = true
        let vault = KeychainSessionVault(store: store)
        XCTAssertThrowsError(try vault.save(authSession())) {
            XCTAssertEqual($0 as? SessionVaultError, .unavailable)
            XCTAssertFalse(String(describing: $0).contains("OSStatus"))
        }
    }

    func testExplicitSignOutBarrierPersistsUntilVerifiedSignInClearsIt() throws {
        let suite = "unfiled-sign-out-barrier-tests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let barrier = ExplicitSignOutBarrier(defaults: defaults, key: "signed-out")

        XCTAssertFalse(barrier.isActive)
        XCTAssertTrue(barrier.activate())
        XCTAssertTrue(barrier.isActive)

        let reloaded = ExplicitSignOutBarrier(defaults: defaults, key: "signed-out")
        XCTAssertTrue(reloaded.isActive)
        XCTAssertTrue(reloaded.clear())
        XCTAssertFalse(reloaded.isActive)
    }
}
