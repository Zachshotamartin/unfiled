import XCTest
@testable import Unfiled

/// The app is live. While it is in front of the owner it keeps asking the server what changed —
/// quickly while a capture is still organizing, slowly when nothing is — so a row moves from
/// organizing to its outcome on the screen the owner is already looking at, rather than only
/// after the app is closed and reopened. It stops entirely when the app is put away or the owner
/// signs out.
@MainActor
final class LiveRefreshTests: XCTestCase {
    private let owner = AuthUser(id: UUID(), email: "owner@example.test")

    /// A tally the loop's closures can raise. They are sendable, so the count lives in a place
    /// they are allowed to reach rather than in the test's own frame.
    @MainActor
    private final class Tally {
        private(set) var value = 0

        func record() {
            value += 1
        }
    }

    private func receipt(id: String, pending: Bool) -> ReceiptPresentation {
        ReceiptPresentation(
            id: id,
            category: pending ? "Organizing" : "Filed",
            time: "NOW",
            headline: pending ? "Organizing" : "Filed in Errands",
            original: "Buy milk",
            outcome: pending ? nil : .createdNote,
            destinationNoteID: nil,
            destinationTitle: nil,
            reviewItemID: nil,
            insertedContent: [],
            actions: [],
            pending: pending,
            retryable: false
        )
    }

    private func makeModel() -> AppModel {
        let defaults = UserDefaults(suiteName: "LiveRefreshTests.\(UUID().uuidString)")!
        return AppModel(bundle: Bundle(for: LiveRefreshTests.self), userDefaults: defaults)
    }

    /// The wait the owner actually watches is a capture still being organized, so the phone asks
    /// as often as the web does in `apps/web/src/lib/product/use-live-resource.ts`.
    func testACaptureStillOrganizingIsAskedAboutAtTheWebsCadence() {
        XCTAssertEqual(LiveRefreshCadence.organizing, .seconds(4))
        XCTAssertEqual(
            LiveRefreshCadence.interval(for: [receipt(id: "cap_a", pending: true)]),
            LiveRefreshCadence.organizing
        )
        XCTAssertEqual(
            LiveRefreshCadence.interval(for: [
                receipt(id: "cap_a", pending: false),
                receipt(id: "cap_b", pending: true)
            ]),
            LiveRefreshCadence.organizing
        )
    }

    /// Nothing is in flight on this phone, so the only changes left were made somewhere else and
    /// the loop backs off rather than asking fifteen times a minute for them.
    func testNothingInFlightBacksOff() {
        XCTAssertEqual(LiveRefreshCadence.idle, .seconds(25))
        XCTAssertEqual(LiveRefreshCadence.interval(for: []), LiveRefreshCadence.idle)
        XCTAssertEqual(
            LiveRefreshCadence.interval(for: [receipt(id: "cap_a", pending: false)]),
            LiveRefreshCadence.idle
        )
        XCTAssertGreaterThan(LiveRefreshCadence.idle, LiveRefreshCadence.organizing)
    }

    func testTheLoopIsLiveOnlyForAnOwnerWhoIsLookingAtIt() {
        XCTAssertTrue(LiveRefreshCadence.isLive(isForeground: true, isSignedIn: true))
        XCTAssertFalse(LiveRefreshCadence.isLive(isForeground: false, isSignedIn: true))
        XCTAssertFalse(LiveRefreshCadence.isLive(isForeground: true, isSignedIn: false))
        XCTAssertFalse(LiveRefreshCadence.isLive(isForeground: false, isSignedIn: false))
    }

    /// A refresh nobody asked for must leave the screen alone apart from its content: the Inbox
    /// disables every button while it loads, and a poll must not nag about a network it is about
    /// to try again.
    func testARefreshNobodyAskedForNeverTakesTheScreenBackToLoading() {
        XCTAssertTrue(AppModel.RefreshReason.explicit.showsLoadingState)
        XCTAssertFalse(AppModel.RefreshReason.live.showsLoadingState)
        XCTAssertTrue(AppModel.RefreshReason.explicit.announcesStoredCopy)
        XCTAssertFalse(AppModel.RefreshReason.live.announcesStoredCopy)
    }

    func testTheLoopKeepsRefreshingUntilItIsStopped() async {
        let loop = LiveRefreshLoop()
        let refreshes = Tally()
        loop.start(interval: { .milliseconds(20) }, refresh: { refreshes.record() })
        XCTAssertTrue(loop.isRunning)

        try? await Task.sleep(for: .milliseconds(300))
        // Fifteen waits fit in three hundred milliseconds. Two is enough to prove the loop did
        // not stop after its first refresh, without asking a shared machine for exact timing.
        XCTAssertGreaterThanOrEqual(refreshes.value, 2)

        loop.stop()
        XCTAssertFalse(loop.isRunning)
        let atStop = refreshes.value
        try? await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(refreshes.value, atStop)
    }

    /// The interval is asked for before every wait, so a capture that starts organizing speeds the
    /// loop up without the loop having to be torn down and rebuilt.
    func testTheIntervalIsAskedForBeforeEveryWait() async {
        let loop = LiveRefreshLoop()
        let intervals = Tally()
        loop.start(interval: { intervals.record(); return .milliseconds(20) }, refresh: {})

        try? await Task.sleep(for: .milliseconds(300))
        loop.stop()
        XCTAssertGreaterThanOrEqual(intervals.value, 2)
    }

    /// A second caller joins the loop that is already running rather than starting a rival that
    /// would double the rate.
    func testStartingAnAlreadyRunningLoopChangesNothing() async {
        let loop = LiveRefreshLoop()
        let first = Tally()
        let second = Tally()
        loop.start(interval: { .milliseconds(20) }, refresh: { first.record() })
        loop.start(interval: { .milliseconds(20) }, refresh: { second.record() })

        try? await Task.sleep(for: .milliseconds(300))
        loop.stop()
        XCTAssertGreaterThanOrEqual(first.value, 2)
        XCTAssertEqual(second.value, 0)
    }

    /// Stopping and starting again is how a capture the owner just wrote retimes the loop: the
    /// next wait begins from the write instead of running out a countdown that started before the
    /// capture existed.
    func testStartingAgainTimesTheNextWaitFromNow() async {
        let loop = LiveRefreshLoop()
        let refreshes = Tally()
        loop.start(interval: { .seconds(30) }, refresh: { refreshes.record() })
        try? await Task.sleep(for: .milliseconds(150))
        XCTAssertEqual(refreshes.value, 0)

        loop.stop()
        loop.start(interval: { .milliseconds(20) }, refresh: { refreshes.record() })
        try? await Task.sleep(for: .milliseconds(300))
        loop.stop()
        XCTAssertGreaterThanOrEqual(refreshes.value, 2)
    }

    /// The complaint this answers: the page did not change until the app was closed and reopened.
    /// The loop now runs for exactly as long as there is an owner looking at the app.
    func testTheLoopRunsForASignedInOwnerAndStopsWhenTheAppIsPutAwayOrTheOwnerSignsOut() async {
        let model = makeModel()
        XCTAssertFalse(model.isLiveRefreshRunningForTesting)

        model.setSessionForTesting(owner)
        XCTAssertTrue(model.isLiveRefreshRunningForTesting)

        await model.becameInactive()
        XCTAssertFalse(model.isLiveRefreshRunningForTesting)

        // A session accepted while the app is away must not start it either.
        model.setSessionForTesting(owner)
        XCTAssertFalse(model.isLiveRefreshRunningForTesting)

        model.setSessionForTesting(nil)
        await model.becameActive()
        XCTAssertFalse(model.isLiveRefreshRunningForTesting)

        model.setSessionForTesting(owner)
        XCTAssertTrue(model.isLiveRefreshRunningForTesting)

        // Nothing is left refreshing behind the test.
        model.setSessionForTesting(nil)
        XCTAssertFalse(model.isLiveRefreshRunningForTesting)
    }
}
