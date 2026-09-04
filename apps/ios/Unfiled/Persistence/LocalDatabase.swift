import Foundation
import GRDB

enum LocalDatabaseError: Error, Equatable {
    case invalidCapture
    case invalidProfile
    case invalidStateTransition
    case unavailable
}

private final class TransientDatabasePassphrase: @unchecked Sendable {
    private let lock = NSLock()
    private var bytes: Data?

    init(_ bytes: Data) {
        self.bytes = bytes
    }

    func apply(to database: Database) throws {
        lock.lock()
        defer { lock.unlock() }
        guard let bytes else { throw LocalDatabaseError.unavailable }
        try database.usePassphrase(bytes)
    }

    func clear() {
        lock.lock()
        defer { lock.unlock() }
        guard var bytes else { return }
        self.bytes = nil
        bytes.resetBytes(in: 0 ..< bytes.count)
    }
}

actor LocalDatabase {
    private static let maximumCaptureCharacters = 10_000
    static let maximumAutomaticCaptureAttempts = 5

    private let database: DatabaseQueue
    private let encoder: JSONEncoder
    private let fileURL: URL

    private init(database: DatabaseQueue, fileURL: URL) {
        self.database = database
        self.fileURL = fileURL
        encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
    }

    static func open(
        bundleIdentifier: String,
        fileManager: FileManager = .default,
        keyProvider: DatabaseKeyProviding? = nil,
        directoryURL: URL? = nil
    ) throws -> LocalDatabase {
        guard !bundleIdentifier.isEmpty else { throw LocalDatabaseError.unavailable }
        let provider = keyProvider ?? KeychainDatabaseKeyStore(bundleIdentifier: bundleIdentifier)
        var key = try provider.loadOrCreateKey()
        defer { key.resetBytes(in: 0 ..< key.count) }
        guard key.count == 32 else { throw LocalDatabaseError.unavailable }
        var passphrase = Self.hexEncodedPassphrase(key)
        let transientPassphrase = TransientDatabasePassphrase(passphrase)
        key.resetBytes(in: 0 ..< key.count)
        passphrase.resetBytes(in: 0 ..< passphrase.count)
        defer { transientPassphrase.clear() }

        let applicationSupport = try directoryURL ?? fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        let directory = directoryURL == nil
            ? applicationSupport.appending(path: "Unfiled", directoryHint: .isDirectory)
            : applicationSupport
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        var directoryValues = URLResourceValues()
        directoryValues.isExcludedFromBackup = true
        var mutableDirectory = directory
        try mutableDirectory.setResourceValues(directoryValues)
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: directory.path
        )

        let fileURL = directory.appending(path: "unfiled-private.sqlite", directoryHint: .notDirectory)
        var configuration = Configuration()
        configuration.label = "Unfiled.SQLCipher"
        configuration.maximumReaderCount = 1
        configuration.prepareDatabase { database in
            try transientPassphrase.apply(to: database)
            try database.execute(sql: "PRAGMA cipher_memory_security = ON")
            try database.execute(sql: "PRAGMA foreign_keys = ON")
            try database.execute(sql: "PRAGMA secure_delete = ON")
            try database.execute(sql: "PRAGMA journal_mode = WAL")
            try database.execute(sql: "PRAGMA busy_timeout = 5000")
        }
        let queue = try DatabaseQueue(path: fileURL.path, configuration: configuration)
        let safeguards = try queue.read { database in
            (
                cipherVersion: try String.fetchOne(database, sql: "PRAGMA cipher_version"),
                cipherMemorySecurity: try Int.fetchOne(
                    database,
                    sql: "PRAGMA cipher_memory_security"
                ),
                foreignKeys: try Int.fetchOne(database, sql: "PRAGMA foreign_keys"),
                secureDelete: try Int.fetchOne(database, sql: "PRAGMA secure_delete"),
                journalMode: try String.fetchOne(database, sql: "PRAGMA journal_mode")
            )
        }
        guard let cipherVersion = safeguards.cipherVersion,
              !cipherVersion.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              safeguards.cipherMemorySecurity == 1,
              safeguards.foreignKeys == 1,
              safeguards.secureDelete == 1,
              safeguards.journalMode?.lowercased() == "wal" else {
            throw LocalDatabaseError.unavailable
        }
        try migrations().migrate(queue)

        let header = try Data(contentsOf: fileURL, options: [.mappedIfSafe]).prefix(16)
        guard header != Data("SQLite format 3\0".utf8) else {
            throw LocalDatabaseError.unavailable
        }

        var databaseValues = URLResourceValues()
        databaseValues.isExcludedFromBackup = true
        var mutableFileURL = fileURL
        try mutableFileURL.setResourceValues(databaseValues)
        try fileManager.setAttributes(
            [.protectionKey: FileProtectionType.complete],
            ofItemAtPath: fileURL.path
        )
        return LocalDatabase(database: queue, fileURL: fileURL)
    }

    func enqueue(
        _ draft: CaptureDraft,
        attachments: [CaptureAttachmentDraft] = [],
        now: String
    ) throws {
        try Self.validate(draft)
        try Self.validateAttachments(attachments)
        try database.write { database in
            try Self.insertCapture(draft, now: now, into: database)
            try Self.insertAttachments(attachments, for: draft, now: now, into: database)
        }
    }

    func enqueue(
        _ draft: CaptureDraft,
        attachments: [CaptureAttachmentDraft] = [],
        removingComposerDraftFor source: LocalCaptureSource,
        composerGeneration: Int,
        now: String
    ) throws {
        try Self.validate(draft)
        try Self.validateAttachments(attachments)
        guard source == draft.source, composerGeneration > 0 else {
            throw LocalDatabaseError.invalidStateTransition
        }
        try database.write { database in
            guard try Self.composerGeneration(
                database,
                profileID: draft.profileID,
                source: source
            ) == composerGeneration else {
                throw LocalDatabaseError.invalidStateTransition
            }
            try Self.insertCapture(draft, now: now, into: database)
            try Self.insertAttachments(attachments, for: draft, now: now, into: database)
            try database.execute(
                sql: "DELETE FROM composer_drafts WHERE profile_id = ? AND source = ?",
                arguments: [draft.profileID, source.rawValue]
            )
            try database.execute(
                sql: """
                UPDATE composer_draft_generations
                SET generation = generation + 1
                WHERE profile_id = ? AND source = ? AND generation = ?
                """,
                arguments: [draft.profileID, source.rawValue, composerGeneration]
            )
            guard database.changesCount == 1 else {
                throw LocalDatabaseError.invalidStateTransition
            }
        }
    }

    func recoverExpiredLeases(
        profileID: String,
        now: String,
        maximumAttempts: Int = maximumAutomaticCaptureAttempts
    ) throws {
        try Self.validateProfile(profileID)
        try Self.validateMaximumAttempts(maximumAttempts)
        try database.write { database in
            try database.execute(
                sql: """
                UPDATE capture_outbox
                SET state = CASE WHEN attempt_count >= ? THEN 'failed' ELSE 'retry' END,
                    lease_token = NULL, lease_expires_at = NULL,
                    last_error_code = CASE
                      WHEN attempt_count >= ? THEN 'retry_limit_reached'
                      ELSE last_error_code
                    END,
                    next_attempt_at = ?, updated_at = ?
                WHERE profile_id = ? AND state = 'leased' AND lease_expires_at <= ?
                """,
                arguments: [maximumAttempts, maximumAttempts, now, now, profileID, now]
            )
        }
    }

    func claimNext(
        profileID: String,
        now: String,
        leaseExpiresAt: String,
        leaseToken: String,
        maximumAttempts: Int = maximumAutomaticCaptureAttempts
    ) throws -> CaptureOutboxEntry? {
        try Self.validateProfile(profileID)
        try Self.validateMaximumAttempts(maximumAttempts)
        guard UUID(uuidString: leaseToken) != nil else {
            throw LocalDatabaseError.invalidStateTransition
        }
        return try database.write { database in
            guard let row = try Row.fetchOne(
                database,
                sql: """
                SELECT * FROM capture_outbox
                WHERE profile_id = ?
                  AND state IN ('pending', 'retry', 'waiting_for_sign_in')
                  AND attempt_count < ?
                  AND next_attempt_at <= ?
                ORDER BY next_attempt_at, created_at, capture_id
                LIMIT 1
                """,
                arguments: [profileID, maximumAttempts, now]
            ) else {
                return nil
            }
            let captureID: String = row["capture_id"]
            try database.execute(
                sql: """
                UPDATE capture_outbox
                SET state = 'leased', attempt_count = attempt_count + 1,
                    lease_token = ?, lease_expires_at = ?, updated_at = ?
                WHERE profile_id = ? AND capture_id = ?
                  AND state IN ('pending', 'retry', 'waiting_for_sign_in')
                  AND attempt_count < ?
                """,
                arguments: [
                    leaseToken,
                    leaseExpiresAt,
                    now,
                    profileID,
                    captureID,
                    maximumAttempts
                ]
            )
            guard database.changesCount == 1 else { return nil }
            return try Self.fetchEntry(database, profileID: profileID, captureID: captureID)
        }
    }

    @discardableResult
    func markRetry(
        profileID: String,
        captureID: String,
        leaseToken: String,
        errorCode: String,
        nextAttemptAt: String,
        now: String,
        maximumAttempts: Int = maximumAutomaticCaptureAttempts,
        /// False when the attempt failed for a reason that says nothing about the capture, such
        /// as an unreachable network. Such an attempt is rescheduled without spending one of the
        /// owner's five, so a minute without signal cannot park a capture forever.
        countsAsAttempt: Bool = true
    ) throws -> CaptureOutboxState {
        try Self.validateProfile(profileID)
        try Self.validateMaximumAttempts(maximumAttempts)
        guard Self.isValidCaptureID(captureID), UUID(uuidString: leaseToken) != nil else {
            throw LocalDatabaseError.invalidStateTransition
        }
        return try database.write { database in
            guard let attemptCount = try Int.fetchOne(
                database,
                sql: """
                SELECT attempt_count FROM capture_outbox
                WHERE profile_id = ? AND capture_id = ? AND state = 'leased'
                  AND lease_token = ?
                """,
                arguments: [profileID, captureID, leaseToken]
            ) else {
                throw LocalDatabaseError.invalidStateTransition
            }
            let nextState: CaptureOutboxState =
                countsAsAttempt && attemptCount >= maximumAttempts ? .failed : .retry
            try database.execute(
                sql: """
                UPDATE capture_outbox
                SET state = ?, lease_token = NULL, lease_expires_at = NULL,
                    attempt_count = attempt_count - CASE WHEN ? THEN 0 ELSE 1 END,
                    last_error_code = ?, next_attempt_at = ?, updated_at = ?
                WHERE profile_id = ? AND capture_id = ? AND state = 'leased'
                  AND lease_token = ?
                """,
                arguments: [
                    nextState.rawValue,
                    countsAsAttempt,
                    nextState == .failed ? "retry_limit_reached" : errorCode,
                    nextState == .failed ? now : nextAttemptAt,
                    now,
                    profileID,
                    captureID,
                    leaseToken
                ]
            )
            guard database.changesCount == 1 else {
                throw LocalDatabaseError.invalidStateTransition
            }
            return nextState
        }
    }

    func retryFailed(profileID: String, captureID: String, now: String) throws {
        try Self.validateProfile(profileID)
        guard Self.isValidCaptureID(captureID) else {
            throw LocalDatabaseError.invalidStateTransition
        }
        try database.write { database in
            try database.execute(
                sql: """
                UPDATE capture_outbox
                SET state = 'retry', attempt_count = 0, next_attempt_at = ?,
                    lease_token = NULL, lease_expires_at = NULL,
                    last_error_code = NULL, updated_at = ?
                WHERE profile_id = ? AND capture_id = ? AND state = 'failed'
                """,
                arguments: [now, now, profileID, captureID]
            )
            guard database.changesCount == 1 else {
                throw LocalDatabaseError.invalidStateTransition
            }
        }
    }

    func markWaitingForSignIn(
        profileID: String,
        captureID: String,
        leaseToken: String,
        now: String,
        maximumAttempts: Int = maximumAutomaticCaptureAttempts
    ) throws {
        try Self.validateProfile(profileID)
        try Self.validateMaximumAttempts(maximumAttempts)
        guard Self.isValidCaptureID(captureID), UUID(uuidString: leaseToken) != nil else {
            throw LocalDatabaseError.invalidStateTransition
        }
        try database.write { database in
            guard let attemptCount = try Int.fetchOne(
                database,
                sql: """
                SELECT attempt_count FROM capture_outbox
                WHERE profile_id = ? AND capture_id = ? AND state = 'leased'
                  AND lease_token = ?
                """,
                arguments: [profileID, captureID, leaseToken]
            ) else {
                throw LocalDatabaseError.invalidStateTransition
            }
            let nextState: CaptureOutboxState = attemptCount >= maximumAttempts
                ? .failed
                : .waitingForSignIn
            try database.execute(
                sql: """
                UPDATE capture_outbox
                SET state = ?, lease_token = NULL, lease_expires_at = NULL,
                    last_error_code = ?, next_attempt_at = ?, updated_at = ?
                WHERE profile_id = ? AND capture_id = ? AND state = 'leased'
                  AND lease_token = ?
                """,
                arguments: [
                    nextState.rawValue,
                    nextState == .failed ? "retry_limit_reached" : "unauthorized",
                    now,
                    now,
                    profileID,
                    captureID,
                    leaseToken
                ]
            )
            guard database.changesCount == 1 else {
                throw LocalDatabaseError.invalidStateTransition
            }
        }
    }

    func markFailed(
        profileID: String,
        captureID: String,
        leaseToken: String,
        errorCode: String,
        now: String
    ) throws {
        try transitionLease(
            profileID: profileID,
            captureID: captureID,
            leaseToken: leaseToken,
            state: .failed,
            errorCode: errorCode,
            nextAttemptAt: now,
            acknowledgement: nil,
            now: now
        )
    }

    func markSynced(
        profileID: String,
        captureID: String,
        leaseToken: String,
        acknowledgement: CaptureSyncAcknowledgement,
        now: String
    ) throws {
        guard acknowledgement.captureID == captureID else {
            throw LocalDatabaseError.invalidStateTransition
        }
        try transitionLease(
            profileID: profileID,
            captureID: captureID,
            leaseToken: leaseToken,
            state: .synced,
            errorCode: nil,
            nextAttemptAt: now,
            acknowledgement: acknowledgement,
            now: now
        )
    }

    func outboxEntries(profileID: String, limit: Int = 100) throws -> [CaptureOutboxEntry] {
        try Self.validateProfile(profileID)
        guard (1 ... 100).contains(limit) else { throw LocalDatabaseError.invalidStateTransition }
        return try database.read { database in
            let rows = try Row.fetchAll(
                database,
                sql: """
                SELECT * FROM capture_outbox
                WHERE profile_id = ?
                ORDER BY created_at DESC, capture_id DESC
                LIMIT ?
                """,
                arguments: [profileID, limit]
            )
            return try rows.map(Self.entry(from:))
        }
    }

    func pendingCount(profileID: String) throws -> Int {
        try Self.validateProfile(profileID)
        return try database.read { database in
            try Int.fetchOne(
                database,
                sql: """
                SELECT count(*) FROM capture_outbox
                WHERE profile_id = ?
                  AND state IN ('pending', 'leased', 'retry', 'waiting_for_sign_in')
                """,
                arguments: [profileID]
            ) ?? 0
        }
    }

    func beginComposerDraftSession(
        profileID: String,
        source: LocalCaptureSource,
        updatedAfter: String
    ) throws -> ComposerDraftSession {
        try Self.validateProfile(profileID)
        return try database.write { database in
            try database.execute(
                sql: """
                INSERT INTO composer_draft_generations (profile_id, source, generation)
                VALUES (?, ?, 0)
                ON CONFLICT(profile_id, source) DO NOTHING
                """,
                arguments: [profileID, source.rawValue]
            )
            try database.execute(
                sql: """
                UPDATE composer_draft_generations
                SET generation = generation + 1
                WHERE profile_id = ? AND source = ?
                """,
                arguments: [profileID, source.rawValue]
            )
            guard database.changesCount == 1,
                  let generation = try Self.composerGeneration(
                      database,
                      profileID: profileID,
                      source: source
                  ) else {
                throw LocalDatabaseError.unavailable
            }
            let draft = try Self.composerDraft(
                database,
                profileID: profileID,
                source: source,
                updatedAfter: updatedAfter
            )
            return ComposerDraftSession(generation: generation, draft: draft)
        }
    }

    @discardableResult
    func saveComposerDraft(_ draft: ComposerDraft, generation: Int) throws -> Bool {
        try Self.validateProfile(draft.profileID)
        guard generation > 0, draft.rawContent.utf16.count <= Self.maximumCaptureCharacters else {
            throw LocalDatabaseError.invalidCapture
        }
        return try database.write { database in
            guard try Self.composerGeneration(
                database,
                profileID: draft.profileID,
                source: draft.source
            ) == generation else {
                return false
            }
            if draft.rawContent.isEmpty {
                try database.execute(
                    sql: "DELETE FROM composer_drafts WHERE profile_id = ? AND source = ?",
                    arguments: [draft.profileID, draft.source.rawValue]
                )
                return true
            }
            try database.execute(
                sql: """
                INSERT INTO composer_drafts (profile_id, source, raw_content, privacy, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(profile_id, source) DO UPDATE SET
                  raw_content = excluded.raw_content,
                  privacy = excluded.privacy,
                  updated_at = excluded.updated_at
                """,
                arguments: [
                    draft.profileID,
                    draft.source.rawValue,
                    draft.rawContent,
                    draft.privacy.rawValue,
                    draft.updatedAt
                ]
            )
            return true
        }
    }

    func recentComposerDraft(
        profileID: String,
        source: LocalCaptureSource,
        updatedAfter: String
    ) throws -> ComposerDraft? {
        try Self.validateProfile(profileID)
        return try database.read { database in
            try Self.composerDraft(
                database,
                profileID: profileID,
                source: source,
                updatedAfter: updatedAfter
            )
        }
    }

    @discardableResult
    func removeComposerDraft(
        profileID: String,
        source: LocalCaptureSource,
        generation: Int
    ) throws -> Bool {
        try Self.validateProfile(profileID)
        guard generation > 0 else { throw LocalDatabaseError.invalidStateTransition }
        return try database.write { database in
            try database.execute(
                sql: """
                UPDATE composer_draft_generations
                SET generation = generation + 1
                WHERE profile_id = ? AND source = ? AND generation = ?
                """,
                arguments: [profileID, source.rawValue, generation]
            )
            guard database.changesCount == 1 else { return false }
            try database.execute(
                sql: "DELETE FROM composer_drafts WHERE profile_id = ? AND source = ?",
                arguments: [profileID, source.rawValue]
            )
            return true
        }
    }

    func cacheNote(_ note: CachedNote) throws {
        try Self.validateProfile(note.profileID)
        guard note.id.hasPrefix("note_"), note.currentRevision > 0, note.payload.count <= 1_500_000 else {
            throw LocalDatabaseError.invalidCapture
        }
        try database.write { database in
            try database.execute(
                sql: """
                INSERT INTO cached_notes (
                  profile_id, note_id, current_revision, payload, cached_at
                ) VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(profile_id, note_id) DO UPDATE SET
                  current_revision = excluded.current_revision,
                  payload = excluded.payload,
                  cached_at = excluded.cached_at
                WHERE cached_notes.current_revision <= excluded.current_revision
                """,
                arguments: [
                    note.profileID,
                    note.id,
                    note.currentRevision,
                    note.payload,
                    note.cachedAt
                ]
            )
        }
    }

    func cachedNote(profileID: String, noteID: String) throws -> CachedNote? {
        try Self.validateProfile(profileID)
        return try database.read { database in
            guard let row = try Row.fetchOne(
                database,
                sql: """
                SELECT * FROM cached_notes WHERE profile_id = ? AND note_id = ?
                """,
                arguments: [profileID, noteID]
            ) else { return nil }
            return CachedNote(
                id: row["note_id"],
                profileID: row["profile_id"],
                currentRevision: row["current_revision"],
                payload: row["payload"],
                cachedAt: row["cached_at"]
            )
        }
    }

    func cachedNotes(profileID: String, limit: Int = 100) throws -> [CachedNote] {
        try Self.validateProfile(profileID)
        guard (1 ... 100).contains(limit) else { throw LocalDatabaseError.invalidStateTransition }
        return try database.read { database in
            let rows = try Row.fetchAll(
                database,
                sql: """
                SELECT note_id, profile_id, current_revision, payload, cached_at
                FROM cached_notes
                WHERE profile_id = ?
                ORDER BY cached_at DESC, note_id DESC
                LIMIT ?
                """,
                arguments: [profileID, limit]
            )
            return rows.map { row in
                CachedNote(
                    id: row["note_id"],
                    profileID: row["profile_id"],
                    currentRevision: row["current_revision"],
                    payload: row["payload"],
                    cachedAt: row["cached_at"]
                )
            }
        }
    }

    func pruneCachedNotes(profileID: String, retaining noteIDs: Set<String>) throws {
        try Self.validateProfile(profileID)
        guard noteIDs.allSatisfy(Self.isValidNoteID) else {
            throw LocalDatabaseError.invalidCapture
        }
        try database.write { database in
            let cachedIDs = try String.fetchAll(
                database,
                sql: "SELECT note_id FROM cached_notes WHERE profile_id = ?",
                arguments: [profileID]
            )
            for noteID in cachedIDs where !noteIDs.contains(noteID) {
                try database.execute(
                    sql: "DELETE FROM cached_notes WHERE profile_id = ? AND note_id = ?",
                    arguments: [profileID, noteID]
                )
            }
        }
    }

    /// The photos and recordings waiting beside one capture, in the order they were added.
    func attachments(profileID: String, captureID: String) throws -> [StoredCaptureAttachment] {
        try Self.validateProfile(profileID)
        return try database.read { database in
            try Row.fetchAll(
                database,
                sql: """
                SELECT * FROM capture_attachments
                WHERE profile_id = ? AND capture_id = ?
                ORDER BY position
                """,
                arguments: [profileID, captureID]
            ).map(Self.storedAttachment(from:))
        }
    }

    func markAttachmentUploaded(profileID: String, attachmentID: String, now: String) throws {
        try Self.validateProfile(profileID)
        try database.write { database in
            try database.execute(
                sql: """
                UPDATE capture_attachments SET uploaded_at = ?
                WHERE profile_id = ? AND attachment_id = ? AND uploaded_at IS NULL
                """,
                arguments: [now, profileID, attachmentID]
            )
        }
    }

    /// The bytes of one photo or recording the owner has already seen, if this phone still holds
    /// them. Reading marks the copy as recently used, so the bound below evicts what the owner
    /// has not looked at rather than what they opened a moment ago.
    func storedAttachmentBytes(profileID: String, attachmentID: String, now: String) throws -> Data? {
        try Self.validateProfile(profileID)
        return try database.write { database in
            let bytes = try Data.fetchOne(
                database,
                sql: "SELECT bytes FROM attachment_store WHERE profile_id = ? AND attachment_id = ?",
                arguments: [profileID, attachmentID]
            )
            if bytes != nil {
                try database.execute(
                    sql: "UPDATE attachment_store SET last_used_at = ? WHERE profile_id = ? AND attachment_id = ?",
                    arguments: [now, profileID, attachmentID]
                )
            }
            return bytes
        }
    }

    /// Keeps a photo the owner has seen, evicting the least recently used copies once the store
    /// passes its budget so a long-lived account cannot fill the phone.
    func storeAttachmentBytes(
        profileID: String,
        attachmentID: String,
        kind: LocalAttachmentKind,
        mediaType: String,
        bytes: Data,
        now: String,
        budgetBytes: Int = LocalDatabase.attachmentStoreBudgetBytes
    ) throws {
        try Self.validateProfile(profileID)
        guard !bytes.isEmpty, bytes.count <= 700_000 else { return }
        try database.write { database in
            try database.execute(
                sql: """
                INSERT INTO attachment_store
                  (profile_id, attachment_id, kind, media_type, bytes, stored_at, last_used_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(profile_id, attachment_id) DO UPDATE SET
                  bytes = excluded.bytes, last_used_at = excluded.last_used_at
                """,
                arguments: [profileID, attachmentID, kind.rawValue, mediaType, bytes, now, now]
            )
            let total = try Int.fetchOne(
                database,
                sql: "SELECT COALESCE(SUM(length(bytes)), 0) FROM attachment_store WHERE profile_id = ?",
                arguments: [profileID]
            ) ?? 0
            guard total > budgetBytes else { return }
            try database.execute(
                sql: """
                DELETE FROM attachment_store
                WHERE profile_id = ? AND attachment_id IN (
                  SELECT attachment_id FROM (
                    SELECT attachment_id,
                           SUM(length(bytes)) OVER (
                             PARTITION BY profile_id ORDER BY last_used_at DESC
                             ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                           ) AS running
                    FROM attachment_store WHERE profile_id = ?
                  ) WHERE running > ?
                )
                """,
                arguments: [profileID, profileID, budgetBytes]
            )
        }
    }

    /// How much of the phone the photo store may use before it evicts the oldest copies.
    static let attachmentStoreBudgetBytes = 120 * 1024 * 1024

    func removeProfile(profileID: String) throws {
        try Self.validateProfile(profileID)
        try database.write { database in
            try database.execute(
                sql: "DELETE FROM capture_attachments WHERE profile_id = ?",
                arguments: [profileID]
            )
            try database.execute(
                sql: "DELETE FROM attachment_store WHERE profile_id = ?",
                arguments: [profileID]
            )
            try database.execute(
                sql: "DELETE FROM capture_outbox WHERE profile_id = ?",
                arguments: [profileID]
            )
            try database.execute(
                sql: "DELETE FROM cached_notes WHERE profile_id = ?",
                arguments: [profileID]
            )
            try database.execute(
                sql: "DELETE FROM composer_drafts WHERE profile_id = ?",
                arguments: [profileID]
            )
            try database.execute(
                sql: "DELETE FROM composer_draft_generations WHERE profile_id = ?",
                arguments: [profileID]
            )
        }
    }

    func storageURLForDiagnostics() -> URL { fileURL }

    private func transitionLease(
        profileID: String,
        captureID: String,
        leaseToken: String,
        state: CaptureOutboxState,
        errorCode: String?,
        nextAttemptAt: String,
        acknowledgement: CaptureSyncAcknowledgement?,
        now: String
    ) throws {
        try Self.validateProfile(profileID)
        guard Self.isValidCaptureID(captureID),
              UUID(uuidString: leaseToken) != nil,
              state != .leased,
              state != .pending else {
            throw LocalDatabaseError.invalidStateTransition
        }
        try database.write { database in
            try database.execute(
                sql: """
                UPDATE capture_outbox
                SET state = ?, lease_token = NULL, lease_expires_at = NULL,
                    last_error_code = ?, next_attempt_at = ?,
                    server_job_id = ?, acknowledged_at = ?, updated_at = ?
                WHERE profile_id = ? AND capture_id = ? AND state = 'leased'
                  AND lease_token = ?
                """,
                arguments: [
                    state.rawValue,
                    errorCode,
                    nextAttemptAt,
                    acknowledgement?.jobID,
                    acknowledgement?.acknowledgedAt,
                    now,
                    profileID,
                    captureID,
                    leaseToken
                ]
            )
            guard database.changesCount == 1 else {
                throw LocalDatabaseError.invalidStateTransition
            }
        }
    }

    static let maximumAttachmentBytes = 700_000
    static let maximumPhotosPerCapture = 4
    static let maximumRecordingsPerCapture = 1

    private static let attachmentIDPattern = #"^att_[0-9A-HJKMNP-TV-Z]{26}$"#

    /// At most four photos and one recording, each a JPEG or an AAC recording under the byte cap,
    /// with the measurements its kind needs and no other.
    private static func validateAttachments(_ attachments: [CaptureAttachmentDraft]) throws {
        let photos = attachments.filter { $0.kind == .image }.count
        let recordings = attachments.count - photos
        guard photos <= maximumPhotosPerCapture, recordings <= maximumRecordingsPerCapture,
              Set(attachments.map(\.id)).count == attachments.count else {
            throw LocalDatabaseError.invalidCapture
        }
        for attachment in attachments {
            guard attachment.id.range(of: attachmentIDPattern, options: .regularExpression) != nil,
                  (1 ... maximumAttachmentBytes).contains(attachment.bytes.count) else {
                throw LocalDatabaseError.invalidCapture
            }
            switch attachment.kind {
            case .image:
                guard attachment.mediaType == "image/jpeg",
                      let width = attachment.width, let height = attachment.height,
                      (1 ... 8_000).contains(width), (1 ... 8_000).contains(height),
                      attachment.durationMs == nil else { throw LocalDatabaseError.invalidCapture }
            case .audio:
                guard attachment.mediaType == "audio/mp4",
                      let duration = attachment.durationMs, (1 ... 120_000).contains(duration),
                      attachment.width == nil, attachment.height == nil else {
                    throw LocalDatabaseError.invalidCapture
                }
            }
        }
    }

    private static func insertAttachments(
        _ attachments: [CaptureAttachmentDraft],
        for draft: CaptureDraft,
        now: String,
        into database: Database
    ) throws {
        for (position, attachment) in attachments.enumerated() {
            try database.execute(
                sql: """
                INSERT INTO capture_attachments (
                  profile_id, capture_id, attachment_id, position, kind, media_type,
                  bytes, width, height, duration_ms, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(profile_id, attachment_id) DO NOTHING
                """,
                arguments: [
                    draft.profileID, draft.id, attachment.id, position, attachment.kind.rawValue,
                    attachment.mediaType, attachment.bytes, attachment.width, attachment.height,
                    attachment.durationMs, now
                ]
            )
        }
    }

    private static func storedAttachment(from row: Row) throws -> StoredCaptureAttachment {
        guard let kind = LocalAttachmentKind(rawValue: row["kind"]) else {
            throw LocalDatabaseError.unavailable
        }
        return StoredCaptureAttachment(
            draft: CaptureAttachmentDraft(
                id: row["attachment_id"],
                kind: kind,
                mediaType: row["media_type"],
                bytes: row["bytes"],
                width: row["width"],
                height: row["height"],
                durationMs: row["duration_ms"]
            ),
            uploadedAt: row["uploaded_at"]
        )
    }

    private static func insertCapture(
        _ draft: CaptureDraft,
        now: String,
        into database: Database
    ) throws {
        try database.execute(
            sql: """
            INSERT INTO capture_outbox (
              profile_id, capture_id, raw_content, source, device_id,
              client_created_at, client_timezone, privacy,
              explicit_destination_note_id, expansion_disabled, guidance, state,
              attempt_count, next_attempt_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
            ON CONFLICT(profile_id, capture_id) DO NOTHING
            """,
            arguments: [
                draft.profileID,
                draft.id,
                draft.rawContent,
                draft.source.rawValue,
                draft.deviceID,
                draft.clientCreatedAt,
                draft.clientTimezone,
                draft.privacy.rawValue,
                draft.explicitDestinationNoteID,
                draft.expansionDisabled,
                draft.guidance,
                now,
                now,
                now
            ]
        )
        guard database.changesCount == 1 else {
            guard let existing = try fetchEntry(
                database,
                profileID: draft.profileID,
                captureID: draft.id
            ), existing.draft == draft else {
                throw LocalDatabaseError.invalidStateTransition
            }
            return
        }
    }

    private static func composerGeneration(
        _ database: Database,
        profileID: String,
        source: LocalCaptureSource
    ) throws -> Int? {
        try Int.fetchOne(
            database,
            sql: """
            SELECT generation FROM composer_draft_generations
            WHERE profile_id = ? AND source = ?
            """,
            arguments: [profileID, source.rawValue]
        )
    }

    private static func composerDraft(
        _ database: Database,
        profileID: String,
        source: LocalCaptureSource,
        updatedAfter: String
    ) throws -> ComposerDraft? {
        guard let row = try Row.fetchOne(
            database,
            sql: """
            SELECT profile_id, source, raw_content, privacy, updated_at
            FROM composer_drafts
            WHERE profile_id = ? AND source = ? AND updated_at >= ?
            """,
            arguments: [profileID, source.rawValue, updatedAfter]
        ),
        let storedSource = LocalCaptureSource(rawValue: row["source"]),
        let privacy = LocalPrivacyMode(rawValue: row["privacy"])
        else { return nil }
        return ComposerDraft(
            profileID: row["profile_id"],
            source: storedSource,
            rawContent: row["raw_content"],
            privacy: privacy,
            updatedAt: row["updated_at"]
        )
    }

    private static func validate(_ draft: CaptureDraft) throws {
        try validateProfile(draft.profileID)
        let trimmed = draft.rawContent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isValidCaptureID(draft.id),
              !trimmed.isEmpty,
              draft.rawContent.utf16.count <= maximumCaptureCharacters,
              !draft.deviceID.isEmpty,
              draft.deviceID.utf16.count <= 120,
              !draft.clientTimezone.isEmpty,
              draft.clientTimezone.utf16.count <= 100 else {
            throw LocalDatabaseError.invalidCapture
        }
    }

    private static func validateProfile(_ profileID: String) throws {
        guard profileID.count == 36,
              UUID(uuidString: profileID) != nil else {
            throw LocalDatabaseError.invalidProfile
        }
    }

    private static func validateMaximumAttempts(_ value: Int) throws {
        guard (1 ... 100).contains(value) else {
            throw LocalDatabaseError.invalidStateTransition
        }
    }

    private static func isValidCaptureID(_ value: String) -> Bool {
        guard value.count == 30, value.hasPrefix("cap_") else { return false }
        let alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        return value.dropFirst(4).allSatisfy(alphabet.contains)
    }

    private static func isValidNoteID(_ value: String) -> Bool {
        guard value.count == 31, value.hasPrefix("note_") else { return false }
        let alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
        return value.dropFirst(5).allSatisfy(alphabet.contains)
    }

    private static func hexEncodedPassphrase(_ key: Data) -> Data {
        let alphabet = Array("0123456789abcdef".utf8)
        var result = Data(capacity: key.count * 2)
        for byte in key {
            result.append(alphabet[Int(byte >> 4)])
            result.append(alphabet[Int(byte & 0x0f)])
        }
        return result
    }

    private static func fetchEntry(
        _ database: Database,
        profileID: String,
        captureID: String
    ) throws -> CaptureOutboxEntry? {
        guard let row = try Row.fetchOne(
            database,
            sql: "SELECT * FROM capture_outbox WHERE profile_id = ? AND capture_id = ?",
            arguments: [profileID, captureID]
        ) else { return nil }
        return try entry(from: row)
    }

    private static func entry(from row: Row) throws -> CaptureOutboxEntry {
        guard let source = LocalCaptureSource(rawValue: row["source"]),
              let privacy = LocalPrivacyMode(rawValue: row["privacy"]),
              let state = CaptureOutboxState(rawValue: row["state"]) else {
            throw LocalDatabaseError.unavailable
        }
        return CaptureOutboxEntry(
            draft: CaptureDraft(
                id: row["capture_id"],
                profileID: row["profile_id"],
                rawContent: row["raw_content"],
                source: source,
                deviceID: row["device_id"],
                clientCreatedAt: row["client_created_at"],
                clientTimezone: row["client_timezone"],
                privacy: privacy,
                explicitDestinationNoteID: row["explicit_destination_note_id"],
                expansionDisabled: row["expansion_disabled"],
                guidance: row["guidance"]
            ),
            state: state,
            attemptCount: row["attempt_count"],
            nextAttemptAt: row["next_attempt_at"],
            leaseToken: row["lease_token"],
            leaseExpiresAt: row["lease_expires_at"],
            lastErrorCode: row["last_error_code"],
            serverJobID: row["server_job_id"],
            acknowledgedAt: row["acknowledged_at"]
        )
    }

    private static func migrations() -> DatabaseMigrator {
        var migrator = DatabaseMigrator()
        migrator.registerMigration("native-v1") { database in
            try database.create(table: "capture_outbox", options: .strict) { table in
                table.column("profile_id", .text).notNull()
                table.column("capture_id", .text).notNull()
                table.column("raw_content", .text).notNull()
                table.column("source", .text).notNull()
                table.column("device_id", .text).notNull()
                table.column("client_created_at", .text).notNull()
                table.column("client_timezone", .text).notNull()
                table.column("privacy", .text).notNull()
                table.column("explicit_destination_note_id", .text)
                table.column("expansion_disabled", .integer).notNull()
                table.column("state", .text).notNull()
                table.column("attempt_count", .integer).notNull().defaults(to: 0)
                table.column("next_attempt_at", .text).notNull()
                table.column("lease_token", .text)
                table.column("lease_expires_at", .text)
                table.column("last_error_code", .text)
                table.column("server_job_id", .text)
                table.column("acknowledged_at", .text)
                table.column("created_at", .text).notNull()
                table.column("updated_at", .text).notNull()
                table.primaryKey(["profile_id", "capture_id"])
                table.check(sql: "length(raw_content) BETWEEN 1 AND 10000")
                table.check(sql: "privacy IN ('ai_assisted', 'private_manual')")
                table.check(
                    sql: "state IN ('pending','leased','retry','waiting_for_sign_in','failed','synced')"
                )
                table.check(sql: "attempt_count >= 0 AND attempt_count <= 100")
                table.check(sql: "expansion_disabled IN (0, 1)")
                table.check(
                    sql: "(state = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)"
                )
            }
            try database.create(
                index: "capture_outbox_ready",
                on: "capture_outbox",
                columns: ["profile_id", "state", "next_attempt_at", "created_at"]
            )
            try database.create(table: "cached_notes", options: .strict) { table in
                table.column("profile_id", .text).notNull()
                table.column("note_id", .text).notNull()
                table.column("current_revision", .integer).notNull()
                table.column("payload", .blob).notNull()
                table.column("cached_at", .text).notNull()
                table.primaryKey(["profile_id", "note_id"])
                table.check(sql: "current_revision > 0")
                table.check(sql: "length(payload) <= 1500000")
            }
            try database.create(table: "composer_drafts", options: .strict) { table in
                table.column("profile_id", .text).notNull()
                table.column("source", .text).notNull()
                table.column("raw_content", .text).notNull()
                table.column("privacy", .text).notNull()
                table.column("updated_at", .text).notNull()
                table.primaryKey(["profile_id", "source"])
                table.check(sql: "length(raw_content) BETWEEN 1 AND 10000")
                table.check(sql: "privacy IN ('ai_assisted', 'private_manual')")
            }
        }
        migrator.registerMigration("native-v3-capture-guidance") { database in
            try database.alter(table: "capture_outbox") { table in
                table.add(column: "guidance", .text)
            }
        }
        migrator.registerMigration("native-v4-capture-attachments") { database in
            try database.create(table: "capture_attachments", options: .strict) { table in
                table.column("profile_id", .text).notNull()
                table.column("capture_id", .text).notNull()
                table.column("attachment_id", .text).notNull()
                table.column("position", .integer).notNull()
                table.column("kind", .text).notNull()
                table.column("media_type", .text).notNull()
                table.column("bytes", .blob).notNull()
                table.column("width", .integer)
                table.column("height", .integer)
                table.column("duration_ms", .integer)
                table.column("uploaded_at", .text)
                table.column("created_at", .text).notNull()
                table.primaryKey(["profile_id", "attachment_id"])
                table.foreignKey(
                    ["profile_id", "capture_id"],
                    references: "capture_outbox",
                    columns: ["profile_id", "capture_id"],
                    onDelete: .cascade
                )
                table.check(sql: "kind IN ('image', 'audio')")
                table.check(sql: "media_type IN ('image/jpeg', 'audio/mp4')")
                table.check(sql: "length(bytes) BETWEEN 1 AND 700000")
                table.check(sql: "position BETWEEN 0 AND 4")
                table.check(sql: """
                (kind = 'image' AND width BETWEEN 1 AND 8000 AND height BETWEEN 1 AND 8000
                  AND duration_ms IS NULL)
                OR (kind = 'audio' AND duration_ms BETWEEN 1 AND 120000
                  AND width IS NULL AND height IS NULL)
                """)
            }
            try database.create(
                index: "capture_attachments_capture",
                on: "capture_attachments",
                columns: ["profile_id", "capture_id", "position"]
            )
        }
        // Photos the owner has seen belong to the owner, not to the capture row that happened to
        // carry them. capture_attachments cascades away with its outbox row, so a photo vanished
        // from the phone once its capture synced and the outbox was pruned. This store keeps a
        // bounded copy that survives that, and answers before the network does.
        migrator.registerMigration("native-v5-attachment-store") { database in
            try database.create(table: "attachment_store", options: .strict) { table in
                table.column("profile_id", .text).notNull()
                table.column("attachment_id", .text).notNull()
                table.column("kind", .text).notNull()
                table.column("media_type", .text).notNull()
                table.column("bytes", .blob).notNull()
                table.column("stored_at", .text).notNull()
                table.column("last_used_at", .text).notNull()
                table.primaryKey(["profile_id", "attachment_id"])
                table.check(sql: "kind IN ('image', 'audio')")
                table.check(sql: "media_type IN ('image/jpeg', 'audio/mp4')")
                table.check(sql: "length(bytes) BETWEEN 1 AND 700000")
            }
            try database.create(
                index: "attachment_store_recency",
                on: "attachment_store",
                columns: ["profile_id", "last_used_at"]
            )
        }
        migrator.registerMigration("native-v2-composer-generations") { database in
            try database.create(table: "composer_draft_generations", options: .strict) { table in
                table.column("profile_id", .text).notNull()
                table.column("source", .text).notNull()
                table.column("generation", .integer).notNull().defaults(to: 0)
                table.primaryKey(["profile_id", "source"])
                table.check(sql: "generation >= 0")
                table.check(sql: "source IN ('mobile','ios_lock_screen_widget','share_sheet')")
            }
        }
        return migrator
    }
}
