import Foundation

enum LocalCaptureSource: String, Codable, CaseIterable, Hashable, Sendable {
    case mobile
    case iosLockScreenWidget = "ios_lock_screen_widget"
    case shareSheet = "share_sheet"
}

enum LocalPrivacyMode: String, Codable, CaseIterable, Hashable, Sendable {
    case aiAssisted = "ai_assisted"
    case privateManual = "private_manual"
}

enum CaptureOutboxState: String, Codable, Sendable {
    case pending
    case leased
    case retry
    case waitingForSignIn = "waiting_for_sign_in"
    case failed
    case synced
}

struct CaptureDraft: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let profileID: String
    let rawContent: String
    let source: LocalCaptureSource
    let deviceID: String
    let clientCreatedAt: String
    let clientTimezone: String
    let privacy: LocalPrivacyMode
    let explicitDestinationNoteID: String?
    let expansionDisabled: Bool
}

struct CaptureOutboxEntry: Codable, Equatable, Identifiable, Sendable {
    let draft: CaptureDraft
    let state: CaptureOutboxState
    let attemptCount: Int
    let nextAttemptAt: String
    let leaseToken: String?
    let leaseExpiresAt: String?
    let lastErrorCode: String?
    let serverJobID: String?
    let acknowledgedAt: String?

    var id: String { draft.id }
}

struct CachedNote: Codable, Equatable, Identifiable, Sendable {
    let id: String
    let profileID: String
    let currentRevision: Int
    let payload: Data
    let cachedAt: String
}

struct CaptureSyncAcknowledgement: Equatable, Sendable {
    let captureID: String
    let jobID: String
    let acknowledgedAt: String
}

struct ComposerDraft: Codable, Equatable, Sendable {
    let profileID: String
    let source: LocalCaptureSource
    let rawContent: String
    let privacy: LocalPrivacyMode
    let updatedAt: String
}

struct ComposerDraftSession: Equatable, Sendable {
    let generation: Int
    let draft: ComposerDraft?
}
