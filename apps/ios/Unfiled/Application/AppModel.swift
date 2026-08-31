import Combine
import Foundation

@MainActor
final class AppModel: ObservableObject {
    private struct Runtime {
        let configuration: AppConfiguration
        let unauthenticatedAPI: APIClient
        let authenticatedAPI: APIClient
        let auth: AuthSessionManager
        let database: LocalDatabase
        let captureSync: CaptureSyncEngine
        let widgetSnapshotStore: WidgetSnapshotStore
    }

    private struct AccountContext: Equatable, Sendable {
        let userID: UUID
        let epoch: UInt64
    }

    @Published private(set) var phase: AppPhase = .booting
    @Published var authStep: AuthStep = .email
    @Published private(set) var currentUser: AuthUser?
    @Published private(set) var notes: [NotePresentation] = []
    @Published private(set) var noteDetails: [String: NoteDetailPresentation] = [:]
    @Published private(set) var spaces: [SpacePresentation] = []
    @Published private(set) var receipts: [ReceiptPresentation] = []
    @Published private(set) var reviewItems: [ReviewPresentation] = []
    @Published private(set) var searchResults: [SearchResultPresentation] = []
    @Published private(set) var archiveNotes: [NotePresentation] = []
    @Published private(set) var deletedNotes: [NotePresentation] = []
    @Published private(set) var revisions: [String: [RevisionPresentation]] = [:]
    @Published private(set) var revisionSnapshots: [String: NoteDetailPresentation] = [:]
    @Published private(set) var isLoadingLibrary = false
    @Published private(set) var isSearching = false
    @Published private(set) var isLoadingReview = false
    @Published private(set) var searchError: String?
    @Published private(set) var reviewError: String?
    @Published var bannerMessage: String?
    @Published var navigationPath: [AppRoute] = []
    @Published var selectedTab: MainTab = .today
    @Published var captureSheet: CaptureSheet?
    @Published var editorSheet: EditorSheet?

    private var runtime: Runtime?
    private var notesByID: [String: Note] = [:]
    private var spacesByID: [String: Space] = [:]
    private var didBootstrap = false
    private var accountEpoch: UInt64 = 0
    private var refreshEpoch: UInt64 = 0
    private var searchEpoch: UInt64 = 0
    private var searchTask: Task<Void, Never>?
    private let explicitSignOutBarrier: ExplicitSignOutBarrier

    init(bundle: Bundle = .main, userDefaults: UserDefaults = .standard) {
        explicitSignOutBarrier = ExplicitSignOutBarrier(defaults: userDefaults)
        do {
            let configuration = try AppConfiguration.load(bundle: bundle)
            let unauthenticatedAPI = try APIClient(baseURL: configuration.apiBaseURL)
            let vault = KeychainSessionVault(
                service: "\(configuration.bundleIdentifier).auth",
                account: "session-v1"
            )
            let auth: AuthSessionManager
            do {
                auth = try AuthSessionManager(vault: vault, remote: unauthenticatedAPI)
            } catch {
                // A corrupt or obsolete local credential must fail closed without trapping the
                // user outside the app. Clearing it never touches server-side notes.
                try? vault.clear()
                auth = try AuthSessionManager(vault: vault, remote: unauthenticatedAPI)
            }
            let authenticatedAPI = try APIClient(
                baseURL: configuration.apiBaseURL,
                tokenProvider: auth
            )
            let database = try LocalDatabase.open(
                bundleIdentifier: configuration.bundleIdentifier
            )
            let widgetSnapshotStore = WidgetSnapshotStore()
            let captureSync = CaptureSyncEngine(
                database: database,
                api: authenticatedAPI,
                profileAuthorizer: auth,
                widgetSnapshotStore: widgetSnapshotStore
            )
            runtime = Runtime(
                configuration: configuration,
                unauthenticatedAPI: unauthenticatedAPI,
                authenticatedAPI: authenticatedAPI,
                auth: auth,
                database: database,
                captureSync: captureSync,
                widgetSnapshotStore: widgetSnapshotStore
            )
        } catch {
            phase = .failed(
                "Unfiled could not open its protected local storage. Restart the app; if the problem continues, reinstall this development build."
            )
        }
    }

    var apiHostLabel: String {
        runtime?.configuration.apiBaseURL.host ?? "Unavailable"
    }

    func bootstrap() async {
        guard !didBootstrap, let runtime else { return }
        didBootstrap = true
        if explicitSignOutBarrier.isActive {
            try? await runtime.auth.clearLocalSession()
            runtime.widgetSnapshotStore.clear()
            phase = .signedOut
            return
        }
        if let user = await runtime.auth.currentUser() {
            runtime.widgetSnapshotStore.clear()
            activate(user)
            await publishWidgetSnapshot(for: user, runtime: runtime)
            if AppGroupConfiguration.consumeQuickCaptureSignal() {
                await prepareCapture(source: .iosLockScreenWidget)
            }
            await refreshAll()
            await runtime.captureSync.activate(profileID: user.id)
            await refreshAll()
        } else {
            runtime.widgetSnapshotStore.clear()
            phase = .signedOut
        }
    }

    func requestOTP(_ request: AuthOTPRequest) async throws -> AuthOTPAcceptedResponse {
        guard let runtime else { throw APIClientError.invalidConfiguration }
        return try await runtime.unauthenticatedAPI.requestOTP(email: request.email)
    }

    func verifyOTP(_ request: AuthOTPVerifyRequest) async throws -> AuthSession {
        guard let runtime else { throw APIClientError.invalidConfiguration }
        return try await runtime.unauthenticatedAPI.verifyAuth(
            email: request.email,
            code: request.code
        )
    }

    func acceptVerifiedSession(_ session: AuthSession) async {
        guard let runtime else { return }
        do {
            if let previousUser = currentUser, previousUser.id != session.user.id {
                await runtime.captureSync.deactivate(profileID: previousUser.id)
            }
            try await runtime.auth.accept(session)
            guard explicitSignOutBarrier.clear() else {
                try? await runtime.auth.clearLocalSession()
                throw AuthenticationError.sessionStorageUnavailable
            }
            runtime.widgetSnapshotStore.clear()
            activate(session.user)
            authStep = .email
            await publishWidgetSnapshot(for: session.user, runtime: runtime)
            if AppGroupConfiguration.consumeQuickCaptureSignal() {
                await prepareCapture(source: .iosLockScreenWidget)
            }
            await refreshAll()
            await runtime.captureSync.activate(profileID: session.user.id)
            await refreshAll()
        } catch {
            bannerMessage = "The session could not be protected in Keychain. Sign in again."
            phase = .signedOut
        }
    }

    func signOut() async {
        guard let runtime else { return }
        guard explicitSignOutBarrier.activate() else {
            bannerMessage = "Unfiled could not safely record sign-out on this iPhone. Try again."
            return
        }
        runtime.widgetSnapshotStore.clear()
        if let user = currentUser {
            await runtime.captureSync.deactivate(profileID: user.id)
        }
        clearAuthenticatedState()
        do {
            try await runtime.auth.signOut()
        } catch {
            bannerMessage = "Signed out on this iPhone. Other server sessions could not be revoked while offline."
        }
    }

    func refreshAll() async {
        guard let runtime, let user = currentUser else { return }
        let context = currentAccountContext(for: user)
        refreshEpoch &+= 1
        let operationEpoch = refreshEpoch
        isLoadingLibrary = true
        isLoadingReview = true
        defer {
            if isCurrent(context), refreshEpoch == operationEpoch {
                isLoadingLibrary = false
                isLoadingReview = false
            }
        }

        async let notesResult = Self.attempt {
            try await Self.fetchAllNotes(api: runtime.authenticatedAPI)
        }
        async let spacesResult = Self.attempt {
            try await Self.fetchAllSpaces(api: runtime.authenticatedAPI)
        }
        async let capturesResult = Self.attempt {
            try await Self.fetchAllCaptures(api: runtime.authenticatedAPI)
        }
        async let reviewsResult = Self.attempt {
            try await Self.fetchAllReviewItems(api: runtime.authenticatedAPI)
        }
        async let outboxResult = Self.attempt {
            try await runtime.captureSync.pendingEntries(profileID: user.id)
        }

        let (notePage, spacePage, capturePage, reviewPage, localOutbox) = await (
            notesResult,
            spacesResult,
            capturesResult,
            reviewsResult,
            outboxResult
        )
        guard isCurrent(context), refreshEpoch == operationEpoch else { return }

        if case let .value(values) = spacePage {
            spacesByID = Dictionary(uniqueKeysWithValues: values.map { ($0.id.rawValue, $0) })
        }

        if case let .value(summaries) = notePage {
            let details = await Self.fetchNoteDetails(
                summaries,
                api: runtime.authenticatedAPI
            )
            guard isCurrent(context), refreshEpoch == operationEpoch else { return }
            for value in details {
                notesByID[value.id.rawValue] = value
                await cache(value, profileID: user.id, database: runtime.database)
            }
            guard isCurrent(context), refreshEpoch == operationEpoch else { return }
            notes = summaries.map { summary in
                notesByID[summary.id.rawValue].map { PresentationMapping.note($0) }
                    ?? PresentationMapping.note(summary)
            }
            .sorted(by: Self.noteSort)
        } else {
            let decoded = await cachedNotes(profileID: user.id, database: runtime.database)
            guard isCurrent(context), refreshEpoch == operationEpoch else { return }
            for note in decoded { notesByID[note.id.rawValue] = note }
            notes = decoded.map { PresentationMapping.note($0) }.sorted(by: Self.noteSort)
            rebuildNoteDetails()
            if !decoded.isEmpty {
                bannerMessage = "Showing the encrypted copy stored on this iPhone."
            }
        }

        let rawSpaces = Array(spacesByID.values)
        spaces = rawSpaces
            .map { space in
                let count = notes.filter { $0.spaceID == space.id.rawValue }.count
                return PresentationMapping.space(space, noteCount: count)
            }
            .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        rebuildNoteDetails()

        let localReceipts: [ReceiptPresentation]
        if case let .value(entries) = localOutbox {
            localReceipts = entries
                .filter { $0.state != .synced }
                .map { PresentationMapping.receipt($0) }
        } else {
            localReceipts = []
        }
        if case let .value(summaries) = capturePage {
            let details = await Self.fetchCaptureDetails(
                summaries.filter(\.receiptAvailable),
                api: runtime.authenticatedAPI
            )
            guard isCurrent(context), refreshEpoch == operationEpoch else { return }
            let detailByID = Dictionary(uniqueKeysWithValues: details.map { ($0.id.rawValue, $0) })
            let serverReceipts = summaries.map { summary in
                detailByID[summary.id.rawValue].map { PresentationMapping.receipt($0) }
                    ?? PresentationMapping.receipt(summary)
            }
            let serverIDs = Set(serverReceipts.map(\.id))
            receipts = (localReceipts.filter { !serverIDs.contains($0.id) } + serverReceipts)
                .prefix(50)
                .map { $0 }
        } else {
            receipts = localReceipts
        }

        if case let .value(items) = reviewPage {
            reviewItems = items.map(PresentationMapping.review)
            reviewError = nil
        } else {
            reviewError = "The review queue is unavailable. Pull to try again."
        }
    }

    func prepareCapture(source: LocalCaptureSource) async {
        guard let runtime, let user = currentUser else {
            phase = .signedOut
            return
        }
        let context = currentAccountContext(for: user)
        do {
            let session = try await runtime.captureSync.beginComposerDraftSession(
                profileID: user.id,
                source: source
            )
            guard isCurrent(context) else { return }
            captureSheet = CaptureSheet(
                source: source,
                composerGeneration: session.generation,
                initialContent: session.draft?.rawContent ?? "",
                initialPrivacy: session.draft?.privacy ?? .aiAssisted,
                restoredDraft: session.draft != nil
            )
        } catch {
            guard isCurrent(context) else { return }
            bannerMessage = "A protected draft session could not be opened. Try again."
        }
    }

    func saveCapture(
        content: String,
        privacy: LocalPrivacyMode,
        source: LocalCaptureSource,
        composerGeneration: Int
    ) async throws {
        guard let runtime, let user = currentUser else { throw AuthenticationError.signedOut }
        let context = currentAccountContext(for: user)
        let captureID = try await runtime.captureSync.enqueue(
            profileID: user.id,
            rawContent: content,
            source: source,
            privacy: privacy,
            deviceID: deviceIdentifier(),
            composerGeneration: composerGeneration
        )
        guard isCurrent(context) else { throw AuthenticationError.signedOut }
        receipts.insert(
            ReceiptPresentation(
                id: captureID,
                category: "Saved",
                time: "NOW",
                headline: "Saved encrypted on this device",
                original: content,
                destinationNoteID: nil,
                undoMutationID: nil,
                expectedRevision: nil,
                pending: true,
                retryable: false
            ),
            at: 0
        )
        Task { @MainActor [weak self] in
            guard let self, self.isCurrent(context) else { return }
            await runtime.captureSync.drain(profileID: user.id)
            guard self.isCurrent(context) else { return }
            await self.refreshAll()
        }
    }

    func saveCaptureDraft(
        content: String,
        privacy: LocalPrivacyMode,
        source: LocalCaptureSource,
        composerGeneration: Int
    ) async throws {
        guard let runtime, let user = currentUser else { throw AuthenticationError.signedOut }
        try await runtime.captureSync.saveComposerDraft(
            profileID: user.id,
            source: source,
            rawContent: content,
            privacy: privacy,
            generation: composerGeneration
        )
    }

    func discardCaptureDraft(
        source: LocalCaptureSource,
        composerGeneration: Int
    ) async throws {
        guard let runtime, let user = currentUser else { throw AuthenticationError.signedOut }
        try await runtime.captureSync.removeComposerDraft(
            profileID: user.id,
            source: source,
            generation: composerGeneration
        )
    }

    func retryCapture(captureID: String) async {
        guard let runtime, let user = currentUser else { return }
        do {
            try await runtime.captureSync.retryFailedCapture(
                profileID: user.id,
                captureID: captureID
            )
            await refreshAll()
        } catch {
            bannerMessage = "That saved capture could not be retried. Try again."
        }
    }

    func becameActive() async {
        guard let runtime, let user = currentUser else { return }
        if AppGroupConfiguration.consumeQuickCaptureSignal() {
            await prepareCapture(source: .iosLockScreenWidget)
        }
        await runtime.captureSync.activate(profileID: user.id)
        await refreshAll()
    }

    func becameInactive() async {
        guard let runtime, let user = currentUser else { return }
        await runtime.captureSync.deactivate(profileID: user.id)
    }

    func handleDeepLink(_ url: URL) async {
        guard let configuredScheme = AppGroupConfiguration.urlScheme,
              AppGroupConfiguration.isValidQuickCaptureURL(
                url,
                expectedScheme: configuredScheme
              )
        else { return }
        await prepareCapture(source: .iosLockScreenWidget)
    }

    func openNote(_ noteID: String) {
        guard NoteID(rawValue: noteID) != nil else { return }
        navigationPath.append(.note(noteID))
    }

    func presentNewNote() {
        editorSheet = EditorSheet(
            draft: NoteEditorDraft(
                noteID: nil,
                title: "",
                bodyMarkdown: "",
                type: .generic,
                privacy: .aiAssisted,
                spaceID: nil
            ),
            currentRevision: nil
        )
    }

    func presentEditor(noteID: String) async {
        guard let user = currentUser else { return }
        let context = currentAccountContext(for: user)
        guard let note = await loadNote(noteID) else {
            guard isCurrent(context) else { return }
            bannerMessage = "This note could not be opened."
            return
        }
        guard isCurrent(context) else { return }
        editorSheet = EditorSheet(
            draft: NoteEditorDraft(
                noteID: note.id.rawValue,
                title: note.title,
                bodyMarkdown: note.bodyMarkdown,
                type: note.type,
                privacy: note.privacy,
                spaceID: note.spaceId?.rawValue
            ),
            currentRevision: note.currentRevision
        )
    }

    func saveNote(_ draft: NoteEditorDraft, expectedRevision: Int?) async throws {
        guard let runtime, let user = currentUser else { throw AuthenticationError.signedOut }
        let context = currentAccountContext(for: user)
        let idempotencyKey = UUID().uuidString.lowercased()
        let result: MutationResult
        if let rawNoteID = draft.noteID {
            guard let noteID = NoteID(rawValue: rawNoteID), let expectedRevision else {
                throw APIClientError.invalidRequest
            }
            let spaceField: PatchField<SpaceID>
            if let rawSpaceID = draft.spaceID {
                guard let spaceID = SpaceID(rawValue: rawSpaceID) else {
                    throw APIClientError.invalidRequest
                }
                spaceField = .value(spaceID)
            } else {
                spaceField = .null
            }
            result = try await runtime.authenticatedAPI.updateNote(
                noteID,
                request: try NoteUpdateRequest(
                    expectedRevision: expectedRevision,
                    idempotencyKey: idempotencyKey,
                    title: .value(draft.title),
                    bodyMarkdown: .value(draft.bodyMarkdown),
                    privacy: .value(draft.privacy),
                    spaceId: spaceField
                )
            )
        } else {
            let spaceID: SpaceID?
            if let rawSpaceID = draft.spaceID {
                guard let parsed = SpaceID(rawValue: rawSpaceID) else {
                    throw APIClientError.invalidRequest
                }
                spaceID = parsed
            } else {
                spaceID = nil
            }
            result = try await runtime.authenticatedAPI.createNote(
                NoteCreateRequest(
                    idempotencyKey: idempotencyKey,
                    title: draft.title,
                    type: draft.type,
                    spaceId: spaceID,
                    privacy: draft.privacy,
                    bodyMarkdown: draft.bodyMarkdown
                )
            )
        }
        guard isCurrent(context) else { throw AuthenticationError.signedOut }
        notesByID[result.note.id.rawValue] = result.note
        rebuildNoteDetails()
        await cache(result.note, profileID: user.id, database: runtime.database)
        guard isCurrent(context) else { throw AuthenticationError.signedOut }
        editorSheet = nil
        await refreshAll()
    }

    func loadNote(_ rawNoteID: String) async -> Note? {
        if let note = notesByID[rawNoteID] { return note }
        guard let runtime, let user = currentUser, let noteID = NoteID(rawValue: rawNoteID) else {
            return nil
        }
        let context = currentAccountContext(for: user)
        do {
            let note = try await runtime.authenticatedAPI.getNote(noteID).note
            guard isCurrent(context) else { return nil }
            notesByID[rawNoteID] = note
            noteDetails[rawNoteID] = PresentationMapping.detail(
                note,
                spaces: Array(spacesByID.values)
            )
            await cache(note, profileID: user.id, database: runtime.database)
            return note
        } catch {
            guard let cached = try? await runtime.database.cachedNote(
                profileID: user.id.uuidString.lowercased(),
                noteID: rawNoteID
            ),
            let note = try? APIJSON.makeDecoder().decode(Note.self, from: cached.payload)
            else { return nil }
            guard isCurrent(context) else { return nil }
            notesByID[rawNoteID] = note
            noteDetails[rawNoteID] = PresentationMapping.detail(
                note,
                spaces: Array(spacesByID.values)
            )
            return note
        }
    }

    func noteDetail(_ noteID: String) -> NoteDetailPresentation? {
        noteDetails[noteID]
    }

    func isArchived(_ noteID: String) -> Bool {
        notesByID[noteID]?.archivedAt != nil
    }

    func toggleChecklistItem(noteID: String, itemID: String, checked: Bool) async throws {
        guard let runtime,
              let user = currentUser,
              let noteIDValue = NoteID(rawValue: noteID),
              let itemIDValue = ItemID(rawValue: itemID),
              let note = notesByID[noteID]
        else { throw APIClientError.invalidRequest }
        let context = currentAccountContext(for: user)
        let result = try await runtime.authenticatedAPI.applyNoteOperations(
            noteIDValue,
            request: InteractiveOperationsRequest(
                expectedRevision: note.currentRevision,
                idempotencyKey: UUID().uuidString.lowercased(),
                operations: [.init(itemId: itemIDValue, checked: checked)]
            )
        )
        guard isCurrent(context) else { throw AuthenticationError.signedOut }
        notesByID[noteID] = result.note
        rebuildNoteDetails()
        await refreshAll()
    }

    func setArchived(noteID: String, archived: Bool) async throws {
        guard let runtime,
              let user = currentUser,
              let id = NoteID(rawValue: noteID),
              let note = notesByID[noteID]
        else { throw APIClientError.invalidRequest }
        let context = currentAccountContext(for: user)
        let result = try await runtime.authenticatedAPI.archiveNote(
            id,
            request: NoteArchiveRequest(
                expectedRevision: note.currentRevision,
                idempotencyKey: UUID().uuidString.lowercased(),
                archived: archived
            )
        )
        guard isCurrent(context) else { throw AuthenticationError.signedOut }
        notesByID[noteID] = result.note
        rebuildNoteDetails()
        await refreshAll()
    }

    func deleteNote(noteID: String) async throws {
        guard let runtime,
              let user = currentUser,
              let id = NoteID(rawValue: noteID),
              let note = notesByID[noteID]
        else { throw APIClientError.invalidRequest }
        let context = currentAccountContext(for: user)
        _ = try await runtime.authenticatedAPI.softDeleteNote(
            id,
            request: .init(
                expectedRevision: note.currentRevision,
                idempotencyKey: UUID().uuidString.lowercased()
            )
        )
        guard isCurrent(context) else { throw AuthenticationError.signedOut }
        navigationPath.removeAll { route in
            if case .note(noteID) = route { return true }
            return false
        }
        await refreshAll()
    }

    func loadRevisions(noteID: String) async {
        guard let runtime, let user = currentUser, let id = NoteID(rawValue: noteID) else { return }
        let context = currentAccountContext(for: user)
        do {
            let items = try await Self.fetchAllRevisions(id: id, api: runtime.authenticatedAPI)
            guard isCurrent(context) else { return }
            revisions[noteID] = items.map { PresentationMapping.revision($0) }
            let rawSpaces = Array(spacesByID.values)
            for revision in items {
                revisionSnapshots[revision.id.rawValue] = PresentationMapping.detail(
                    revision,
                    spaces: rawSpaces
                )
            }
        } catch {
            guard isCurrent(context) else { return }
            bannerMessage = "Revision history could not be loaded."
        }
    }

    func restoreRevision(noteID: String, revisionID: String, expectedRevision: Int) async throws {
        guard let runtime,
              let user = currentUser,
              let id = NoteID(rawValue: noteID),
              let revision = RevisionID(rawValue: revisionID)
        else { throw APIClientError.invalidRequest }
        let context = currentAccountContext(for: user)
        let result = try await runtime.authenticatedAPI.restoreNoteRevision(
            id,
            request: NoteRestoreRequest(
                expectedRevision: expectedRevision,
                idempotencyKey: UUID().uuidString.lowercased(),
                revisionId: revision
            )
        )
        guard isCurrent(context) else { throw AuthenticationError.signedOut }
        notesByID[noteID] = result.note
        rebuildNoteDetails()
        await loadRevisions(noteID: noteID)
        await refreshAll()
    }

    func undo(mutationID: String, expectedRevision: Int) async {
        guard let runtime, let user = currentUser, let id = MutationID(rawValue: mutationID) else { return }
        let context = currentAccountContext(for: user)
        do {
            let result = try await runtime.authenticatedAPI.undoMutation(
                id,
                request: .init(
                    expectedRevision: expectedRevision,
                    idempotencyKey: UUID().uuidString.lowercased()
                )
            )
            guard isCurrent(context) else { return }
            notesByID[result.note.id.rawValue] = result.note
            rebuildNoteDetails()
            bannerMessage = "The organized change was undone."
            await refreshAll()
        } catch {
            guard isCurrent(context) else { return }
            bannerMessage = "That change could not be undone because the note has moved on."
        }
    }

    func search(query: String, includesArchived: Bool) {
        searchTask?.cancel()
        searchEpoch &+= 1
        let operationEpoch = searchEpoch
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else {
            searchResults = []
            searchError = nil
            isSearching = false
            return
        }
        guard let runtime, let user = currentUser else { return }
        let context = currentAccountContext(for: user)
        isSearching = true
        searchError = nil
        searchTask = Task { @MainActor [weak self] in
            do {
                let items = try await Self.fetchAllSearchResults(
                    query: normalized,
                    archive: includesArchived ? .include : .exclude,
                    api: runtime.authenticatedAPI
                )
                guard let self,
                      !Task.isCancelled,
                      self.isCurrent(context),
                      self.searchEpoch == operationEpoch else { return }
                self.searchResults = items.map { PresentationMapping.search($0) }
                self.isSearching = false
            } catch {
                guard let self,
                      !Task.isCancelled,
                      self.isCurrent(context),
                      self.searchEpoch == operationEpoch else { return }
                self.searchError = "Search is unavailable. Check your connection and try again."
                self.isSearching = false
            }
        }
    }

    func loadArchive() async {
        guard let user = currentUser else { return }
        let context = currentAccountContext(for: user)
        let loaded = await loadNoteSubset(archive: .only, deleted: .exclude)
        guard isCurrent(context) else { return }
        archiveNotes = loaded
    }

    func loadDeleted() async {
        guard let user = currentUser else { return }
        let context = currentAccountContext(for: user)
        let loaded = await loadNoteSubset(archive: .include, deleted: .only)
        guard isCurrent(context) else { return }
        deletedNotes = loaded
    }

    func restoreDeleted(noteID: String) async throws {
        guard let runtime, let user = currentUser, let id = NoteID(rawValue: noteID) else {
            throw APIClientError.invalidRequest
        }
        let context = currentAccountContext(for: user)
        let note: Note
        if let loaded = notesByID[noteID] {
            note = loaded
        } else if let loaded = await loadNote(noteID) {
            note = loaded
        } else {
            throw APIClientError.invalidRequest
        }
        let result = try await runtime.authenticatedAPI.restoreDeletedNote(
            id,
            request: .init(
                expectedRevision: note.currentRevision,
                idempotencyKey: UUID().uuidString.lowercased()
            )
        )
        guard isCurrent(context) else { throw AuthenticationError.signedOut }
        notesByID[noteID] = result.note
        rebuildNoteDetails()
        await loadDeleted()
        await refreshAll()
    }

    private func loadNoteSubset(
        archive: ArchiveFilter,
        deleted: DeletedFilter
    ) async -> [NotePresentation] {
        guard let runtime, let user = currentUser else { return [] }
        let context = currentAccountContext(for: user)
        do {
            let summaries = try await Self.fetchAllNotes(
                api: runtime.authenticatedAPI,
                archive: archive,
                deleted: deleted
            )
            let details = await Self.fetchNoteDetails(summaries, api: runtime.authenticatedAPI)
            guard isCurrent(context) else { return [] }
            for note in details { notesByID[note.id.rawValue] = note }
            rebuildNoteDetails()
            return summaries.map { summary in
                notesByID[summary.id.rawValue].map { PresentationMapping.note($0) }
                    ?? PresentationMapping.note(summary)
            }
        } catch {
            guard isCurrent(context) else { return [] }
            bannerMessage = "This part of the library could not be loaded."
            return []
        }
    }

    private func cache(_ note: Note, profileID: UUID, database: LocalDatabase) async {
        guard let payload = try? APIJSON.makeEncoder().encode(note) else { return }
        try? await database.cacheNote(
            CachedNote(
                id: note.id.rawValue,
                profileID: profileID.uuidString.lowercased(),
                currentRevision: note.currentRevision,
                payload: payload,
                cachedAt: APIJSON.dateString(Date())
            )
        )
    }

    private func cachedNotes(profileID: UUID, database: LocalDatabase) async -> [Note] {
        guard let cached = try? await database.cachedNotes(
            profileID: profileID.uuidString.lowercased()
        ) else { return [] }
        return cached.compactMap {
            try? APIJSON.makeDecoder().decode(Note.self, from: $0.payload)
        }
    }

    private func activate(_ user: AuthUser) {
        clearAuthenticatedState()
        currentUser = user
        phase = .signedIn
    }

    private func clearAuthenticatedState() {
        accountEpoch &+= 1
        refreshEpoch &+= 1
        searchEpoch &+= 1
        searchTask?.cancel()
        searchTask = nil
        currentUser = nil
        notes = []
        spaces = []
        receipts = []
        reviewItems = []
        searchResults = []
        archiveNotes = []
        deletedNotes = []
        revisions = [:]
        revisionSnapshots = [:]
        notesByID = [:]
        noteDetails = [:]
        spacesByID = [:]
        navigationPath = []
        captureSheet = nil
        editorSheet = nil
        authStep = .email
        isLoadingLibrary = false
        isLoadingReview = false
        isSearching = false
        searchError = nil
        reviewError = nil
        phase = .signedOut
    }

    private func currentAccountContext(for user: AuthUser) -> AccountContext {
        AccountContext(userID: user.id, epoch: accountEpoch)
    }

    private func isCurrent(_ context: AccountContext) -> Bool {
        currentUser?.id == context.userID && accountEpoch == context.epoch && phase == .signedIn
    }

    private func publishWidgetSnapshot(for user: AuthUser, runtime: Runtime) async {
        let context = currentAccountContext(for: user)
        let count = (try? await runtime.database.pendingCount(
            profileID: user.id.uuidString.lowercased()
        )) ?? 0
        guard isCurrent(context) else { return }
        runtime.widgetSnapshotStore.publish(pendingCaptureCount: count)
    }

    private func deviceIdentifier() -> String {
        let key = "unfiled.device.identifier.v1"
        if let value = UserDefaults.standard.string(forKey: key), UUID(uuidString: value) != nil {
            return value.lowercased()
        }
        let value = UUID().uuidString.lowercased()
        UserDefaults.standard.set(value, forKey: key)
        return value
    }

    private func rebuildNoteDetails() {
        let rawSpaces = Array(spacesByID.values)
        noteDetails = notesByID.mapValues {
            PresentationMapping.detail($0, spaces: rawSpaces)
        }
    }

    private static func noteSort(_ lhs: NotePresentation, _ rhs: NotePresentation) -> Bool {
        if lhs.pinned != rhs.pinned { return lhs.pinned }
        if lhs.updatedAt != rhs.updatedAt { return lhs.updatedAt > rhs.updatedAt }
        return lhs.id > rhs.id
    }

    private nonisolated static func attempt<Value: Sendable>(
        _ operation: @escaping @Sendable () async throws -> Value
    ) async -> AsyncLoadResult<Value> {
        do { return .value(try await operation()) }
        catch { return .unavailable }
    }

    private nonisolated static func fetchNoteDetails(
        _ summaries: [NoteSummary],
        api: APIClient
    ) async -> [Note] {
        var details: [Note] = []
        for start in stride(from: 0, to: summaries.count, by: 12) {
            guard !Task.isCancelled else { break }
            let end = min(start + 12, summaries.count)
            let batch = await withTaskGroup(of: Note?.self, returning: [Note].self) { group in
                for summary in summaries[start ..< end] {
                    group.addTask {
                        try? await api.getNote(summary.id).note
                    }
                }
                var values: [Note] = []
                for await value in group {
                    if let value { values.append(value) }
                }
                return values
            }
            details.append(contentsOf: batch)
        }
        return details
    }

    private nonisolated static func fetchCaptureDetails(
        _ summaries: [CaptureSummary],
        api: APIClient
    ) async -> [CaptureDetail] {
        var details: [CaptureDetail] = []
        for start in stride(from: 0, to: summaries.count, by: 12) {
            guard !Task.isCancelled else { break }
            let end = min(start + 12, summaries.count)
            let batch = await withTaskGroup(
                of: CaptureDetail?.self,
                returning: [CaptureDetail].self
            ) { group in
                for summary in summaries[start ..< end] {
                    group.addTask {
                        try? await api.getCapture(summary.id).capture
                    }
                }
                var values: [CaptureDetail] = []
                for await value in group {
                    if let value { values.append(value) }
                }
                return values
            }
            details.append(contentsOf: batch)
        }
        return details
    }

    private nonisolated static func fetchAllNotes(
        api: APIClient,
        archive: ArchiveFilter = .exclude,
        deleted: DeletedFilter = .exclude
    ) async throws -> [NoteSummary] {
        var items: [NoteSummary] = []
        var cursor: String?
        var seen = Set<String>()
        for _ in 0 ..< 200 {
            let page = try await api.listNotes(
                .init(cursor: cursor, limit: 100, archive: archive, deleted: deleted)
            )
            items.append(contentsOf: page.items)
            guard let next = try validatedNextCursor(page.pageInfo, seen: &seen) else {
                return items
            }
            cursor = next
        }
        throw PaginationError.pageLimitExceeded
    }

    private nonisolated static func fetchAllSpaces(api: APIClient) async throws -> [Space] {
        var items: [Space] = []
        var cursor: String?
        var seen = Set<String>()
        for _ in 0 ..< 200 {
            let page = try await api.listSpaces(.init(cursor: cursor, limit: 100))
            items.append(contentsOf: page.items)
            guard let next = try validatedNextCursor(page.pageInfo, seen: &seen) else {
                return items
            }
            cursor = next
        }
        throw PaginationError.pageLimitExceeded
    }

    private nonisolated static func fetchAllCaptures(api: APIClient) async throws -> [CaptureSummary] {
        var items: [CaptureSummary] = []
        var cursor: String?
        var seen = Set<String>()
        for _ in 0 ..< 200 {
            let page = try await api.listCaptures(.init(cursor: cursor, limit: 100))
            items.append(contentsOf: page.items)
            guard let next = try validatedNextCursor(page.pageInfo, seen: &seen) else {
                return items
            }
            cursor = next
        }
        throw PaginationError.pageLimitExceeded
    }

    private nonisolated static func fetchAllReviewItems(api: APIClient) async throws -> [ReviewItem] {
        var items: [ReviewItem] = []
        var cursor: String?
        var seen = Set<String>()
        for _ in 0 ..< 200 {
            let page = try await api.listReviewItems(.init(cursor: cursor, limit: 100))
            items.append(contentsOf: page.items)
            guard let next = try validatedNextCursor(page.pageInfo, seen: &seen) else {
                return items
            }
            cursor = next
        }
        throw PaginationError.pageLimitExceeded
    }

    private nonisolated static func fetchAllSearchResults(
        query: String,
        archive: ArchiveFilter,
        api: APIClient
    ) async throws -> [SearchNoteResult] {
        var items: [SearchNoteResult] = []
        var cursor: String?
        var seen = Set<String>()
        for _ in 0 ..< 200 {
            try Task.checkCancellation()
            let page = try await api.searchNotes(
                .init(query: query, archive: archive, cursor: cursor, limit: 100)
            )
            items.append(contentsOf: page.items)
            guard let next = try validatedNextCursor(page.pageInfo, seen: &seen) else {
                return items
            }
            cursor = next
        }
        throw PaginationError.pageLimitExceeded
    }

    private nonisolated static func fetchAllRevisions(
        id: NoteID,
        api: APIClient
    ) async throws -> [NoteRevision] {
        var items: [NoteRevision] = []
        var cursor: String?
        var seen = Set<String>()
        for _ in 0 ..< 200 {
            let page = try await api.listNoteRevisions(id, cursor: cursor, limit: 100)
            items.append(contentsOf: page.items)
            guard let next = try validatedNextCursor(page.pageInfo, seen: &seen) else {
                return items
            }
            cursor = next
        }
        throw PaginationError.pageLimitExceeded
    }

    private nonisolated static func validatedNextCursor(
        _ pageInfo: PageInfo,
        seen: inout Set<String>
    ) throws -> String? {
        if !pageInfo.hasMore {
            guard pageInfo.nextCursor == nil else { throw PaginationError.inconsistentPageInfo }
            return nil
        }
        guard let cursor = pageInfo.nextCursor,
              !cursor.isEmpty,
              seen.insert(cursor).inserted else {
            throw PaginationError.inconsistentPageInfo
        }
        return cursor
    }
}

private enum PaginationError: Error, Sendable {
    case inconsistentPageInfo
    case pageLimitExceeded
}
