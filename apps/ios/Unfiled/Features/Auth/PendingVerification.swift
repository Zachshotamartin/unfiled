import Foundation

/// What the code-entry screen needs to survive the app being backgrounded, terminated, or relaunched:
/// which address is waiting, and when its last code went out. The password is deliberately not part
/// of it — the account already exists by the time this value is written, and nothing here can create
/// or open one on its own.
struct PendingVerification: Codable, Equatable, Sendable {
    /// An entry older than a day is not worth reopening: the code died long ago, and a screen asking
    /// for digits that can no longer work is a dead end. The account still exists, so the owner
    /// belongs on the sign-in screen instead.
    static let lifetime: TimeInterval = 24 * 60 * 60

    let email: String
    let codeSentAt: Date

    /// A stored entry counts only while it is recent. An entry stamped in the future means the device
    /// clock moved after it was written, so it is held to the same window in both directions rather
    /// than being trusted indefinitely.
    func isCurrent(at now: Date) -> Bool {
        abs(now.timeIntervalSince(codeSentAt)) < Self.lifetime
    }

    /// A new value stamped with the moment another code went out; the address is unchanged.
    func sending(at date: Date) -> PendingVerification {
        PendingVerification(email: email, codeSentAt: date)
    }
}

/// Keeps the pending confirmation across launches. `UserDefaults` is the right home: the value is an
/// address the owner just typed and a timestamp, not a secret, and it must be readable at launch
/// before any session exists.
struct PendingVerificationStore {
    static let defaultKey = "unfiled.auth.pending-verification.v1"

    private let defaults: UserDefaults
    private let key: String

    init(defaults: UserDefaults = .standard, key: String = defaultKey) {
        self.defaults = defaults
        self.key = key
    }

    func load(now: Date) -> PendingVerification? {
        guard let data = defaults.data(forKey: key) else { return nil }
        guard let value = try? APIJSON.makeDecoder().decode(PendingVerification.self, from: data),
              AuthEmailContract.isNormalized(value.email),
              value.isCurrent(at: now)
        else {
            // An unreadable or expired entry must not strand the owner on a screen the app cannot
            // explain, so it is dropped here rather than carried forward.
            clear()
            return nil
        }
        return value
    }

    /// Reports whether the entry will still be there after a relaunch. A refusal costs only that
    /// resumption; the caller keeps the value in memory for the launch it is already in.
    @discardableResult
    func save(_ value: PendingVerification) -> Bool {
        guard let data = try? APIJSON.makeEncoder().encode(value) else { return false }
        defaults.set(data, forKey: key)
        return defaults.data(forKey: key) == data
    }

    func clear() {
        defaults.removeObject(forKey: key)
    }
}
