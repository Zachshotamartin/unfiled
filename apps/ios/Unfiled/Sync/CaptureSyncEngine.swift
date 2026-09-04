import Foundation

enum CaptureSyncEngineError: Error, Equatable {
    case invalidProfile
    case invalidCaptureIdentifier
    case invalidServerAcknowledgement
}

protocol CaptureProfileAuthorizing: Sendable {
    func authorizesCaptureProfile(_ profileID: UUID) async -> Bool
    func captureAccessToken(for profileID: UUID) async throws -> String
    func refreshCaptureAccessToken(
        for profileID: UUID,
        rejectedToken: String
    ) async throws -> String
}

actor CaptureSyncEngine {
    typealias Clock = @Sendable () -> Date
    typealias RetryDelay = @Sendable (Int) -> TimeInterval

    private let database: LocalDatabase
    private let api: APIClient
    private let profileAuthorizer: any CaptureProfileAuthorizing
    private let idGenerator: PrefixedULIDGenerator
    private let clock: Clock
    private let retryPollInterval: Duration
    private let retryDelay: RetryDelay
    private var drainingProfiles: Set<String> = []
    private var activeProfiles: Set<String> = []
    private var retryLifecycleTasks: [String: Task<Void, Never>] = [:]

    init(
        database: LocalDatabase,
        api: APIClient,
        profileAuthorizer: any CaptureProfileAuthorizing,
        idGenerator: PrefixedULIDGenerator = PrefixedULIDGenerator(),
        clock: @escaping Clock = { Date() },
        retryPollInterval: Duration = .seconds(15),
        retryDelay: @escaping RetryDelay = {
            min(900.0, pow(2, Double(min($0, 8))))
        }
    ) {
        self.database = database
        self.api = api
        self.profileAuthorizer = profileAuthorizer
        self.idGenerator = idGenerator
        self.clock = clock
        self.retryPollInterval = retryPollInterval
        self.retryDelay = retryDelay
    }

    @discardableResult
    func enqueue(
        profileID: UUID,
        rawContent: String,
        source: LocalCaptureSource,
        privacy: LocalPrivacyMode,
        deviceID: String,
        composerGeneration: Int,
        explicitDestinationNoteID: String? = nil,
        expansionDisabled: Bool = false,
        guidance: String? = nil,
        attachments: [CaptureAttachmentDraft] = []
    ) async throws -> String {
        guard await profileAuthorizer.authorizesCaptureProfile(profileID) else {
            throw CaptureSyncEngineError.invalidProfile
        }
        let captureID = try await idGenerator.next(.capture)
        let now = clock()
        let encodedNow = APIJSON.dateString(now)
        let draft = CaptureDraft(
            id: captureID,
            profileID: profileID.uuidString.lowercased(),
            rawContent: rawContent,
            source: source,
            deviceID: deviceID,
            clientCreatedAt: encodedNow,
            clientTimezone: TimeZone.current.identifier,
            privacy: privacy,
            explicitDestinationNoteID: explicitDestinationNoteID,
            expansionDisabled: expansionDisabled,
            guidance: CaptureCreateRequest.normalizedGuidance(guidance)
        )
        try await database.enqueue(
            draft,
            attachments: attachments,
            removingComposerDraftFor: source,
            composerGeneration: composerGeneration,
            now: encodedNow
        )
        return captureID
    }

    /// Enqueues a capture that did not come from the composer: organizing an existing capture
    /// again, with the owner's directions attached.
    @discardableResult
    func enqueueAgain(
        profileID: UUID,
        rawContent: String,
        source: LocalCaptureSource,
        privacy: LocalPrivacyMode,
        deviceID: String,
        guidance: String?,
        attachments: [CaptureAttachmentDraft] = []
    ) async throws -> String {
        guard await profileAuthorizer.authorizesCaptureProfile(profileID) else {
            throw CaptureSyncEngineError.invalidProfile
        }
        let captureID = try await idGenerator.next(.capture)
        let encodedNow = APIJSON.dateString(clock())
        let draft = CaptureDraft(
            id: captureID,
            profileID: profileID.uuidString.lowercased(),
            rawContent: rawContent,
            source: source,
            deviceID: deviceID,
            clientCreatedAt: encodedNow,
            clientTimezone: TimeZone.current.identifier,
            privacy: privacy,
            explicitDestinationNoteID: nil,
            expansionDisabled: false,
            guidance: CaptureCreateRequest.normalizedGuidance(guidance)
        )
        try await database.enqueue(draft, attachments: attachments, now: encodedNow)
        return captureID
    }

    func activate(profileID: UUID) async {
        let normalizedProfileID = profileID.uuidString.lowercased()
        guard await profileAuthorizer.authorizesCaptureProfile(profileID) else {
            deactivate(profileID: profileID)
            return
        }
        activeProfiles.insert(normalizedProfileID)
        if retryLifecycleTasks[normalizedProfileID] != nil {
            await drain(profileID: profileID)
            return
        }

        await drain(profileID: profileID)
        guard activeProfiles.contains(normalizedProfileID),
              await profileAuthorizer.authorizesCaptureProfile(profileID),
              retryLifecycleTasks[normalizedProfileID] == nil else { return }
        let interval = retryPollInterval
        retryLifecycleTasks[normalizedProfileID] = Task { [weak self] in
            while !Task.isCancelled {
                do {
                    try await Task.sleep(for: interval)
                } catch {
                    return
                }
                guard let self else { return }
                await self.drain(profileID: profileID)
            }
        }
    }

    func deactivate(profileID: UUID) {
        let normalizedProfileID = profileID.uuidString.lowercased()
        activeProfiles.remove(normalizedProfileID)
        retryLifecycleTasks
            .removeValue(forKey: normalizedProfileID)?
            .cancel()
    }

    func drain(profileID: UUID) async {
        let normalizedProfileID = profileID.uuidString.lowercased()
        guard activeProfiles.contains(normalizedProfileID),
              await profileAuthorizer.authorizesCaptureProfile(profileID) else { return }
        guard drainingProfiles.insert(normalizedProfileID).inserted else { return }
        defer { drainingProfiles.remove(normalizedProfileID) }

        let now = APIJSON.dateString(clock())
        try? await database.recoverExpiredLeases(profileID: normalizedProfileID, now: now)

        while !Task.isCancelled {
            do {
                guard activeProfiles.contains(normalizedProfileID),
                      await profileAuthorizer.authorizesCaptureProfile(profileID) else { break }
                let claimedAt = clock()
                let leaseToken = UUID().uuidString.lowercased()
                guard let entry = try await database.claimNext(
                    profileID: normalizedProfileID,
                    now: APIJSON.dateString(claimedAt),
                    leaseExpiresAt: APIJSON.dateString(claimedAt.addingTimeInterval(120)),
                    leaseToken: leaseToken
                ) else { break }

                guard activeProfiles.contains(normalizedProfileID),
                      await profileAuthorizer.authorizesCaptureProfile(profileID) else {
                    try? await database.markWaitingForSignIn(
                        profileID: normalizedProfileID,
                        captureID: entry.draft.id,
                        leaseToken: leaseToken,
                        now: APIJSON.dateString(clock())
                    )
                    break
                }

                let shouldContinue = await submit(
                    entry,
                    profileID: profileID,
                    leaseToken: leaseToken
                )
                if !shouldContinue { break }
            } catch {
                break
            }
        }
    }

    func pendingEntries(profileID: UUID) async throws -> [CaptureOutboxEntry] {
        try await database.outboxEntries(profileID: profileID.uuidString.lowercased())
    }

    func retryFailedCapture(profileID: UUID, captureID: String) async throws {
        guard await profileAuthorizer.authorizesCaptureProfile(profileID) else {
            throw CaptureSyncEngineError.invalidProfile
        }
        let normalizedProfileID = profileID.uuidString.lowercased()
        let now = APIJSON.dateString(clock())
        try await database.retryFailed(
            profileID: normalizedProfileID,
            captureID: captureID,
            now: now
        )
        await drain(profileID: profileID)
    }

    func saveComposerDraft(
        profileID: UUID,
        source: LocalCaptureSource,
        rawContent: String,
        privacy: LocalPrivacyMode,
        generation: Int
    ) async throws {
        try await database.saveComposerDraft(
            ComposerDraft(
                profileID: profileID.uuidString.lowercased(),
                source: source,
                rawContent: rawContent,
                privacy: privacy,
                updatedAt: APIJSON.dateString(clock())
            ),
            generation: generation
        )
    }

    func beginComposerDraftSession(
        profileID: UUID,
        source: LocalCaptureSource,
        maximumAge: TimeInterval = 30 * 60
    ) async throws -> ComposerDraftSession {
        try await database.beginComposerDraftSession(
            profileID: profileID.uuidString.lowercased(),
            source: source,
            updatedAfter: APIJSON.dateString(clock().addingTimeInterval(-maximumAge))
        )
    }

    func removeComposerDraft(
        profileID: UUID,
        source: LocalCaptureSource,
        generation: Int
    ) async throws {
        try await database.removeComposerDraft(
            profileID: profileID.uuidString.lowercased(),
            source: source,
            generation: generation
        )
    }

    private func submit(
        _ entry: CaptureOutboxEntry,
        profileID: UUID,
        leaseToken: String
    ) async -> Bool {
        let normalizedProfileID = profileID.uuidString.lowercased()
        guard activeProfiles.contains(normalizedProfileID),
              await profileAuthorizer.authorizesCaptureProfile(profileID) else {
            try? await database.markWaitingForSignIn(
                profileID: normalizedProfileID,
                captureID: entry.draft.id,
                leaseToken: leaseToken,
                now: APIJSON.dateString(clock())
            )
            return false
        }
        do {
            guard let captureID = CaptureID(rawValue: entry.draft.id),
                  let createdAt = APIJSON.parseDate(entry.draft.clientCreatedAt)
            else { throw CaptureSyncEngineError.invalidCaptureIdentifier }
            let accessToken = try await profileAuthorizer.captureAccessToken(for: profileID)

            // Photos and recordings go up first, each once; the capture then names them.
            let attachments = try await database.attachments(
                profileID: normalizedProfileID,
                captureID: entry.draft.id
            )
            for attachment in attachments where attachment.uploadedAt == nil {
                _ = try await api.uploadCaptureAttachment(
                    CaptureAttachmentUpload(
                        attachmentId: attachment.draft.id,
                        captureId: entry.draft.id,
                        kind: attachment.draft.kind == .image ? .image : .audio,
                        mediaType: attachment.draft.mediaType,
                        privacy: apiPrivacy(entry.draft.privacy),
                        width: attachment.draft.width,
                        height: attachment.draft.height,
                        durationMs: attachment.draft.durationMs,
                        bytes: attachment.draft.bytes
                    ),
                    accessToken: accessToken
                )
                try await database.markAttachmentUploaded(
                    profileID: normalizedProfileID,
                    attachmentID: attachment.draft.id,
                    now: APIJSON.dateString(clock())
                )
            }

            let request = CaptureCreateRequest(
                clientCaptureId: captureID,
                rawContent: entry.draft.rawContent,
                source: apiSource(entry.draft.source),
                deviceId: entry.draft.deviceID,
                clientCreatedAt: createdAt,
                clientTimezone: entry.draft.clientTimezone,
                privacy: apiPrivacy(entry.draft.privacy),
                explicitDestinationNoteId: entry.draft.explicitDestinationNoteID.flatMap(NoteID.init(rawValue:)),
                expansionDisabled: entry.draft.expansionDisabled,
                guidance: entry.draft.guidance,
                attachmentIds: attachments.isEmpty ? nil : attachments.map(\.draft.id)
            )
            let response: CaptureCreateResponse
            do {
                response = try await api.createCapture(
                    request,
                    idempotencyKey: entry.draft.id,
                    accessToken: accessToken
                )
            } catch {
                guard isUnauthorizedHTTP(error) else { throw error }
                let refreshedToken = try await profileAuthorizer.refreshCaptureAccessToken(
                    for: profileID,
                    rejectedToken: accessToken
                )
                response = try await api.createCapture(
                    request,
                    idempotencyKey: entry.draft.id,
                    accessToken: refreshedToken
                )
            }
            guard response.capture.id == captureID else {
                throw CaptureSyncEngineError.invalidServerAcknowledgement
            }
            try await database.markSynced(
                profileID: normalizedProfileID,
                captureID: entry.draft.id,
                leaseToken: leaseToken,
                acknowledgement: CaptureSyncAcknowledgement(
                    captureID: entry.draft.id,
                    jobID: response.jobId.rawValue,
                    acknowledgedAt: APIJSON.dateString(clock())
                ),
                now: APIJSON.dateString(clock())
            )
            return true
        } catch {
            let now = clock()
            if isAuthenticationFailure(error) {
                try? await database.markWaitingForSignIn(
                    profileID: normalizedProfileID,
                    captureID: entry.draft.id,
                    leaseToken: leaseToken,
                    now: APIJSON.dateString(now)
                )
                return false
            }
            if isPermanentFailure(error) {
                try? await database.markFailed(
                    profileID: normalizedProfileID,
                    captureID: entry.draft.id,
                    leaseToken: leaseToken,
                    errorCode: safeErrorCode(error),
                    now: APIJSON.dateString(now)
                )
                return true
            }
            let delay = retryDelay(entry.attemptCount)
            _ = try? await database.markRetry(
                profileID: normalizedProfileID,
                captureID: entry.draft.id,
                leaseToken: leaseToken,
                errorCode: safeErrorCode(error),
                nextAttemptAt: APIJSON.dateString(now.addingTimeInterval(delay)),
                now: APIJSON.dateString(now)
            )
            return true
        }
    }


    private func apiSource(_ source: LocalCaptureSource) -> CaptureSource {
        switch source {
        case .mobile: .mobile
        case .iosLockScreenWidget: .iosLockScreenWidget
        case .shareSheet: .shareSheet
        }
    }

    private func apiPrivacy(_ privacy: LocalPrivacyMode) -> PrivacyMode {
        privacy == .privateManual ? .privateManual : .aiAssisted
    }

    private func isAuthenticationFailure(_ error: Error) -> Bool {
        if error is AuthenticationError { return true }
        if case APIClientError.authenticationRequired = error { return true }
        if case let APIClientError.http(status, _, _, _) = error, status == 401 { return true }
        return false
    }

    private func isUnauthorizedHTTP(_ error: Error) -> Bool {
        if case let APIClientError.http(status, _, _, _) = error, status == 401 { return true }
        return false
    }

    private func isPermanentFailure(_ error: Error) -> Bool {
        guard case let APIClientError.http(status, code, _, _) = error else {
            return error is CaptureSyncEngineError
        }
        if status == 408 || status == 409 || status == 425 || status == 429 || status >= 500 {
            return false
        }
        return code != .providerUnavailable && code != .rateLimited
    }

    private func safeErrorCode(_ error: Error) -> String {
        if case let APIClientError.http(status, code, _, _) = error {
            return code?.rawValue ?? "http_\(status)"
        }
        if error is CaptureSyncEngineError { return "invalid_server_acknowledgement" }
        return "network_unavailable"
    }
}
