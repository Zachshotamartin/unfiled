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

    func enqueue(_ draft: CaptureDraft, now: String) throws {
        try Self.validate(draft)
        try database.write { database in
            try Self.insertCapture(draft, now: now, into: database)
        }
    }

    func enqueue(
        _ draft: CaptureDraft,
        removingComposerDraftFor source: LocalCaptureSource,
        composerGeneration: Int,
        now: String
    ) throws {
        try Self.validate(draft)
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
        maximumAttempts: Int = maximumAutomaticCaptureAttempts
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
            let nextState: CaptureOutboxState = attemptCount >= maximumAttempts ? .failed : .retry
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

    func removeProfile(profileID: String) throws {
        try Self.validateProfile(profileID)
        try database.write { database in
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
              explicit_destination_note_id, expansion_disabled, state,
              attempt_count, next_attempt_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
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
                expansionDisabled: row["expansion_disabled"]
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
