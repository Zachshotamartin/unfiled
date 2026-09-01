import Combine
import Foundation
import UIKit

struct ActiveNoteMembership: Equatable, Sendable {
    private(set) var ids: Set<String> = []

    mutating func replace(with authoritativeIDs: Set<String>) {
        ids = authoritativeIDs
    }

    mutating func update(noteID: String, isActive: Bool) {
        if isActive {
            ids.insert(noteID)
        } else {
            ids.remove(noteID)
        }
    }
}

struct ReviewQueueGeneration: Equatable, Sendable {
    private(set) var value: UInt64 = 0

    mutating func beginRequest() -> UInt64 {
        value &+= 1
        return value
    }

    mutating func invalidate() {
        value &+= 1
    }

    func accepts(_ requestGeneration: UInt64) -> Bool {
        requestGeneration == value
    }
}

struct PaginationIdentityValidator: Equatable, Sendable {
    private var seen = Set<String>()

    mutating func accept(_ identifiers: [String]) throws {
        let pageIdentifiers = Set(identifiers)
        guard pageIdentifiers.count == identifiers.count,
              seen.isDisjoint(with: pageIdentifiers) else {
            throw PaginationError.duplicateItemIdentifier
        }
        seen.formUnion(pageIdentifiers)
    }
}

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
    @Published private(set) var captureDetails: [String: ReceiptPresentation] = [:]
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
    @Published private(set) var captureDetailLoadingIDs: Set<String> = []
    @Published private(set) var captureDetailErrors: [String: String] = [:]
    @Published private(set) var submittingInteractionIDs: Set<String> = []
    @Published private(set) var interactionErrors: [String: String] = [:]
    @Published private(set) var requestedReviewFocusID: String?
    @Published var bannerMessage: String?
    @Published var navigationPath: [AppRoute] = []
    @Published var selectedTab: MainTab = .today
    @Published var captureSheet: CaptureSheet?
    @Published var editorSheet: EditorSheet?
    @Published var destinationPickerSheet: DestinationPickerSheet?

    private var runtime: Runtime?
    private var notesByID: [String: Note] = [:]
    private var activeNoteMembership = ActiveNoteMembership()
    private var spacesByID: [String: Space] = [:]
    private var capturesByID: [String: CaptureDetail] = [:]
    private var reviewCapturesByID: [String: CaptureDetail] = [:]
    private var captureDetailEpochs: [String: UInt64] = [:]
    private var reviewItemsByID: [String: ReviewItem] = [:]
    private var reviewQueueGeneration = ReviewQueueGeneration()
    private var correctionAttempts: [String: DecisionCorrectionRequest] = [:]
    private var reviewAttempts: [String: ReviewResolveRequest] = [:]
    private var undoAttempts: [String: MutationUndoRequest] = [:]
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
        let reviewOperationGeneration = reviewQueueGeneration.beginRequest()
        let activeNoteIDsAtStart = activeNoteMembership.ids
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
            var valuesByID: [String: Space] = [:]
            for value in values {
                valuesByID[value.id.rawValue] = value
            }
            spacesByID = valuesByID
        }

        if case let .value(summaries) = notePage {
            let details = await Self.fetchNoteDetails(
                summaries,
                api: runtime.authenticatedAPI
            )
            guard isCurrent(context), refreshEpoch == operationEpoch else { return }
            let authoritativeIDs = Set(summaries.map { $0.id.rawValue })
            let currentActiveIDs = activeNoteMembership.ids
            let addedWhileRefreshing = currentActiveIDs.subtracting(activeNoteIDsAtStart)
            let removedWhileRefreshing = activeNoteIDsAtStart.subtracting(currentActiveIDs)
            let reconciledActiveIDs = authoritativeIDs
                .union(addedWhileRefreshing)
                .subtracting(removedWhileRefreshing)
            let staleActiveIDs = activeNoteIDsAtStart
                .intersection(currentActiveIDs)
                .subtracting(authoritativeIDs)
            activeNoteMembership.replace(with: reconciledActiveIDs)
            for noteID in staleActiveIDs {
                notesByID.removeValue(forKey: noteID)
                noteDetails.removeValue(forKey: noteID)
            }
            for value in details {
                if notesByID[value.id.rawValue].map({
                    $0.currentRevision > value.currentRevision
                }) != true {
                    notesByID[value.id.rawValue] = value
                    await cache(value, profileID: user.id, database: runtime.database)
                }
            }
            try? await runtime.database.pruneCachedNotes(
                profileID: user.id.uuidString.lowercased(),
                retaining: activeNoteMembership.ids
            )
            guard isCurrent(context), refreshEpoch == operationEpoch else { return }
            let summaryFallbacks = Dictionary(
                uniqueKeysWithValues: summaries.map {
                    ($0.id.rawValue, PresentationMapping.note($0))
                }
            )
            rebuildActiveNotes(additionalFallbacks: summaryFallbacks)
        } else {
            let decoded = await cachedNotes(profileID: user.id, database: runtime.database)
            guard isCurrent(context), refreshEpoch == operationEpoch else { return }
            for note in decoded where notesByID[note.id.rawValue].map({
                $0.currentRevision > note.currentRevision
            }) != true {
                notesByID[note.id.rawValue] = note
            }
            for note in decoded {
                let current = notesByID[note.id.rawValue] ?? note
                activeNoteMembership.update(
                    noteID: current.id.rawValue,
                    isActive: Self.isActiveNote(current)
                )
            }
            rebuildActiveNotes()
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
            let receiptSummaries = summaries.filter(\.receiptAvailable)
            let detailEpochSnapshot = Dictionary(
                uniqueKeysWithValues: receiptSummaries.map {
                    ($0.id.rawValue, captureDetailEpochs[$0.id.rawValue, default: 0])
                }
            )
            let details = await Self.fetchCaptureDetails(
                receiptSummaries,
                api: runtime.authenticatedAPI
            )
            guard isCurrent(context), refreshEpoch == operationEpoch else { return }
            // A receipt fetched before a correction or undo began must not overwrite the
            // explicit post-mutation refresh for that capture.
            let currentDetails = details.filter {
                captureDetailEpochs[$0.id.rawValue, default: 0]
                    == detailEpochSnapshot[$0.id.rawValue]
            }
            for detail in currentDetails {
                capturesByID[detail.id.rawValue] = detail
                captureDetails[detail.id.rawValue] = PresentationMapping.receipt(detail)
            }
            let detailByID = Dictionary(
                uniqueKeysWithValues: currentDetails.map { ($0.id.rawValue, $0) }
            )
            let serverReceipts = summaries.map { summary in
                detailByID[summary.id.rawValue].map { PresentationMapping.receipt($0) }
                    ?? captureDetails[summary.id.rawValue]
                    ?? PresentationMapping.receipt(summary)
            }
            let serverIDs = Set(serverReceipts.map(\.id))
            receipts = (localReceipts.filter { !serverIDs.contains($0.id) } + serverReceipts)
                .prefix(50)
                .map { $0 }
        } else {
            receipts = localReceipts
        }

        if reviewQueueGeneration.accepts(reviewOperationGeneration) {
            if case let .value(items) = reviewPage {
                let captureIDs = Self.reviewCaptureIDs(items)
                let detailEpochSnapshot = Dictionary(
                    uniqueKeysWithValues: captureIDs.map {
                        ($0.rawValue, captureDetailEpochs[$0.rawValue, default: 0])
                    }
                )
                let details = await Self.fetchCaptureDetails(
                    captureIDs,
                    api: runtime.authenticatedAPI
                )
                guard isCurrent(context),
                      refreshEpoch == operationEpoch,
                      reviewQueueGeneration.accepts(reviewOperationGeneration) else { return }
                let currentDetails = details.filter {
                    captureDetailEpochs[$0.id.rawValue, default: 0]
                        == detailEpochSnapshot[$0.id.rawValue]
                }
                for detail in currentDetails {
                    _ = applyCaptureDetail(detail)
                }
                publishReviewItems(items, captureDetails: currentDetails)
            } else {
                reviewError = "The review queue is unavailable. Pull to try again."
            }
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
                outcome: nil,
                destinationNoteID: nil,
                destinationTitle: nil,
                reviewItemID: nil,
                insertedContent: [],
                actions: [],
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

    func openCapture(_ captureID: String) {
        guard CaptureID(rawValue: captureID) != nil else { return }
        navigationPath.append(.capture(captureID))
    }

    func captureDetail(_ captureID: String) -> ReceiptPresentation? {
        captureDetails[captureID] ?? receipts.first { $0.id == captureID }
    }

    func loadCaptureDetail(captureID: String, force: Bool = false) async {
        _ = await refreshCaptureDetail(captureID: captureID, force: force)
    }

    private func refreshCaptureDetail(
        captureID: String,
        force: Bool = false
    ) async -> ReceiptPresentation? {
        guard let runtime,
              let user = currentUser,
              let id = CaptureID(rawValue: captureID) else { return nil }
        guard force || !captureDetailLoadingIDs.contains(captureID) else { return nil }
        let context = currentAccountContext(for: user)
        let operationEpoch = captureDetailEpochs[captureID, default: 0] &+ 1
        captureDetailEpochs[captureID] = operationEpoch
        captureDetailLoadingIDs.insert(captureID)
        captureDetailErrors.removeValue(forKey: captureID)
        defer {
            if isCurrent(context), captureDetailEpochs[captureID] == operationEpoch {
                captureDetailLoadingIDs.remove(captureID)
            }
        }
        do {
            let detail = try await runtime.authenticatedAPI.getCapture(id).capture
            guard isCurrent(context), captureDetailEpochs[captureID] == operationEpoch else {
                return nil
            }
            guard detail.id == id else {
                throw APIClientError.malformedResponse(status: 200)
            }
            return applyCaptureDetail(detail)
        } catch {
            guard isCurrent(context), captureDetailEpochs[captureID] == operationEpoch else {
                return nil
            }
            captureDetailErrors[captureID] =
                "This receipt could not be refreshed. Check your connection and try again."
            return nil
        }
    }

    func showReview(reviewID: String? = nil) {
        navigationPath = []
        selectedTab = .review
        requestedReviewFocusID = reviewID
    }

    func presentCorrection(
        captureID: String,
        sourceNoteID: String,
        decisionID: String
    ) {
        guard let source = NoteID(rawValue: sourceNoteID),
              let decision = DecisionID(rawValue: decisionID),
              let capture = capturesByID[captureID],
              capture.receipt?.actions.contains(
                  .move(noteId: source, decisionId: decision)
              ) == true else { return }
        interactionErrors.removeValue(forKey: "correction.\(decisionID)")
        destinationPickerSheet = DestinationPickerSheet(
            purpose: .correction(
                captureID: captureID,
                decisionID: decisionID,
                sourceNoteID: sourceNoteID
            ),
            initialMode: .existing,
            suggestedTitle: "",
            suggestedType: .generic,
            suggestedSpaceID: nil
        )
    }

    func presentReviewDestination(
        reviewID: String,
        initialMode: DestinationPickerMode
    ) {
        guard let item = reviewItemsByID[reviewID] else { return }
        let allowed = PresentationMapping.reviewAllowedActions(
            for: item,
            capture: reviewCapture(for: item)
        )
        guard (initialMode == .existing && allowed.contains(.route)) ||
              (initialMode == .newNote && allowed.contains(.create)) else { return }
        let suggestion = reviewItems.first { $0.id == reviewID }?.suggestedNewNote
        interactionErrors.removeValue(forKey: "review.\(reviewID)")
        destinationPickerSheet = DestinationPickerSheet(
            purpose: .review(reviewID: reviewID),
            initialMode: initialMode,
            suggestedTitle: suggestion?.title ?? "",
            suggestedType: suggestion?.noteType ?? .generic,
            suggestedSpaceID: suggestion?.spaceID
        )
    }

    func submitDestination(
        _ choice: DestinationChoice,
        for sheet: DestinationPickerSheet
    ) async {
        // A delayed sheet callback must never submit against a newer interaction.
        guard destinationPickerSheet == sheet else { return }
        switch sheet.purpose {
        case let .correction(captureID, decisionID, sourceNoteID):
            await performCorrection(
                captureID: captureID,
                decisionID: decisionID,
                sourceNoteID: sourceNoteID,
                choice: choice
            )
        case let .review(reviewID):
            await performReviewDestination(reviewID: reviewID, choice: choice)
        }
    }

    func handleReviewAction(reviewID: String, action: ReviewUserAction) async {
        guard let item = reviewItemsByID[reviewID] else { return }
        let allowed = PresentationMapping.reviewAllowedActions(
            for: item,
            capture: reviewCapture(for: item)
        )
        switch action {
        case let .route(noteID):
            guard allowed.contains(.route) else { return }
            await performReviewRoute(reviewID: reviewID, noteID: noteID)
        case .chooseDestination:
            guard allowed.contains(.route) else { return }
            presentReviewDestination(reviewID: reviewID, initialMode: .existing)
        case .createNote:
            guard allowed.contains(.create) else { return }
            presentReviewDestination(reviewID: reviewID, initialMode: .newNote)
        case .keepInbox:
            guard allowed.contains(.keepInbox) else { return }
            await performReviewResolution(reviewID: reviewID, resolution: .keepInbox)
        case .dismiss:
            guard allowed.contains(.dismiss) else { return }
            await performReviewResolution(reviewID: reviewID, resolution: .dismiss)
        case .keepBoth:
            guard allowed.contains(.keepBoth) else { return }
            await performReviewResolution(reviewID: reviewID, resolution: .keepBoth)
        }
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
        await applyNoteBatch([result.note], user: user, runtime: runtime, context: context)
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
        await applyNoteBatch([result.note], user: user, runtime: runtime, context: context)
        guard isCurrent(context) else { throw AuthenticationError.signedOut }
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
        await applyNoteBatch([result.note], user: user, runtime: runtime, context: context)
        guard isCurrent(context) else { throw AuthenticationError.signedOut }
        await refreshAll()
    }

    func deleteNote(noteID: String) async throws {
        guard let runtime,
              let user = currentUser,
              let id = NoteID(rawValue: noteID),
              let note = notesByID[noteID]
        else { throw APIClientError.invalidRequest }
        let context = currentAccountContext(for: user)
        let result = try await runtime.authenticatedAPI.softDeleteNote(
            id,
            request: .init(
                expectedRevision: note.currentRevision,
                idempotencyKey: UUID().uuidString.lowercased()
            )
        )
        guard isCurrent(context) else { throw AuthenticationError.signedOut }
        await applyNoteBatch([result.note], user: user, runtime: runtime, context: context)
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
        await applyNoteBatch([result.note], user: user, runtime: runtime, context: context)
        guard isCurrent(context) else { throw AuthenticationError.signedOut }
        await loadRevisions(noteID: noteID)
        await refreshAll()
    }

    func undoReceipt(
        captureID: String,
        mutationID: String,
        expectedRevision: Int
    ) async {
        guard let runtime,
              let user = currentUser,
              let mutation = MutationID(rawValue: mutationID),
              let capture = capturesByID[captureID],
              let receipt = capture.receipt,
              receipt.actions.contains(
                  .undo(mutationId: mutation, expectedRevision: expectedRevision)
              ),
              receipt.mutationId == mutation,
              let anchorNoteID = receipt.destination?.noteId else { return }
        let operationID = "receipt.undo.\(captureID)"
        guard beginInteraction(operationID) else { return }
        let context = currentAccountContext(for: user)
        let intentID = "\(operationID)|\(mutationID)|\(expectedRevision)"
        defer { endInteraction(operationID, context: context) }

        do {
            let request: MutationUndoRequest
            if let existing = undoAttempts[intentID] {
                request = existing
            } else {
                let anchor = try await runtime.authenticatedAPI.getNote(anchorNoteID).note
                guard isCurrent(context),
                      anchor.id == anchorNoteID,
                      let requestRevision = Self.undoRequestExpectedRevision(
                          receiptExpectedRevision: expectedRevision,
                          currentRevision: anchor.currentRevision
                      ) else {
                    throw APIClientError.malformedResponse(status: 200)
                }
                request = try MutationUndoRequest(
                    expectedRevision: requestRevision,
                    idempotencyKey: UUID().uuidString.lowercased()
                )
                undoAttempts[intentID] = request
            }
            let response = try await runtime.authenticatedAPI.undoMutationBatch(
                mutation,
                request: request
            )
            guard isCurrent(context) else { return }

            // The strict batch DTO decodes completely before any in-memory note is replaced.
            let updatedNotes = response.members.map(\.note)
            await applyNoteBatch(updatedNotes, user: user, runtime: runtime, context: context)
            guard isCurrent(context) else { return }
            undoAttempts.removeValue(forKey: intentID)
            interactionErrors.removeValue(forKey: operationID)
            await loadCaptureDetail(captureID: captureID, force: true)
            guard isCurrent(context) else { return }
            bannerMessage = updatedNotes.count == 1
                ? "The organized change was undone."
                : "The organized changes were undone together."
            announce(bannerMessage ?? "The organized change was undone.")
        } catch {
            guard isCurrent(context) else { return }
            if !Self.isAmbiguousInteractionFailure(error) {
                undoAttempts.removeValue(forKey: intentID)
            }
            if Self.shouldFocusReviewAfterUndo(for: error) {
                reviewQueueGeneration.invalidate()
                let refreshedReceipt = await refreshCaptureDetail(
                    captureID: captureID,
                    force: true
                )
                let authoritativeReviewID = Self.authoritativeReviewFocusID(
                    captureID: captureID,
                    refreshedReceipt: refreshedReceipt
                )
                await refreshReviewQueue(runtime: runtime, context: context)
                guard isCurrent(context) else { return }
                if let authoritativeReviewID {
                    showReview(reviewID: authoritativeReviewID)
                    interactionErrors[operationID] =
                        "Nothing changed. Review the saved capture before trying another action."
                } else {
                    interactionErrors[operationID] =
                        "Review was saved, but its receipt could not be loaded. Refresh this receipt to continue."
                }
                bannerMessage = interactionErrors[operationID]
            } else {
                interactionErrors[operationID] = Self.interactionFailureMessage(
                    error,
                    fallback: "Undo could not be confirmed. Try again from this receipt."
                )
                bannerMessage = interactionErrors[operationID]
            }
            announce(bannerMessage ?? "Undo could not be confirmed.")
        }
    }

    private func performCorrection(
        captureID: String,
        decisionID: String,
        sourceNoteID: String,
        choice: DestinationChoice
    ) async {
        guard let runtime,
              let user = currentUser,
              let decision = DecisionID(rawValue: decisionID),
              let sourceID = NoteID(rawValue: sourceNoteID),
              let capture = capturesByID[captureID],
              capture.receipt?.actions.contains(
                  .move(noteId: sourceID, decisionId: decision)
              ) == true else { return }
        let operationID = "correction.\(decisionID)"
        guard beginInteraction(operationID) else { return }
        let context = currentAccountContext(for: user)
        let intentID = Self.correctionIntentID(
            operationID: operationID,
            sourceNoteID: sourceNoteID,
            choice: choice
        )
        defer { endInteraction(operationID, context: context) }

        do {
            let request: DecisionCorrectionRequest
            if let existing = correctionAttempts[intentID] {
                request = existing
            } else {
                let source: Note
                let destination: CorrectionDestination
                switch choice {
                case let .existing(rawDestinationID):
                    guard let destinationID = NoteID(rawValue: rawDestinationID) else {
                        throw APIClientError.invalidRequest
                    }
                    async let sourceResponse = runtime.authenticatedAPI.getNote(sourceID)
                    async let destinationResponse = runtime.authenticatedAPI.getNote(destinationID)
                    let fetched = try await (sourceResponse, destinationResponse)
                    guard Self.fetchedNote(fetched.0.note, matches: sourceID) else {
                        throw APIClientError.malformedResponse(status: 200)
                    }
                    source = fetched.0.note
                    destination = try Self.validatedCorrectionDestination(
                        fetched.1.note,
                        matches: destinationID
                    )
                case let .newNote(title, noteType, rawSpaceID):
                    source = try await runtime.authenticatedAPI.getNote(sourceID).note
                    let spaceID: SpaceID?
                    if let rawSpaceID {
                        guard let parsed = SpaceID(rawValue: rawSpaceID) else {
                            throw APIClientError.invalidRequest
                        }
                        spaceID = parsed
                    } else {
                        spaceID = nil
                    }
                    destination = .newNote(
                        title: title,
                        noteType: noteType,
                        spaceId: spaceID
                    )
                }
                guard isCurrent(context), source.id == sourceID else {
                    throw AuthenticationError.signedOut
                }
                request = try DecisionCorrectionRequest(
                    idempotencyKey: UUID().uuidString.lowercased(),
                    source: try CorrectionSource(
                        noteId: source.id,
                        expectedRevision: source.currentRevision
                    ),
                    destination: destination
                )
                correctionAttempts[intentID] = request
            }

            let response = try await runtime.authenticatedAPI.correctDecision(
                decision,
                request: request
            )
            guard isCurrent(context),
                  Self.correctionResponse(response, matches: request, decision: decision) else {
                throw APIClientError.malformedResponse(status: 200)
            }
            correctionAttempts.removeValue(forKey: intentID)
            interactionErrors.removeValue(forKey: operationID)
            destinationPickerSheet = nil

            switch response {
            case let .applied(applied):
                let noteIDs = [applied.source.noteId, applied.destination.note.noteId]
                let refreshed = await refreshNotesAtomically(
                    noteIDs,
                    minimumRevisions: [
                        applied.source.noteId: applied.source.currentRevision,
                        applied.destination.note.noteId:
                            applied.destination.note.currentRevision
                    ],
                    user: user,
                    runtime: runtime,
                    context: context
                )
                await loadCaptureDetail(captureID: captureID, force: true)
                guard isCurrent(context) else { return }
                bannerMessage = refreshed
                    ? "Moved to the selected note."
                    : "Moved, but the latest notes could not be loaded. Pull to refresh."
                announce(bannerMessage ?? "Moved to the selected note.")
            case let .needsReview(needsReview):
                // This outcome is explicitly no-op for notes. Refresh only the receipt and Review.
                reviewQueueGeneration.invalidate()
                await loadCaptureDetail(captureID: captureID, force: true)
                await refreshReviewQueue(runtime: runtime, context: context)
                guard isCurrent(context) else { return }
                showReview(reviewID: needsReview.reviewItemId.rawValue)
                bannerMessage = "Nothing moved. Review what should happen next."
                announce("Nothing moved. The capture needs review.")
            }
        } catch {
            guard isCurrent(context) else { return }
            if !Self.isAmbiguousInteractionFailure(error) {
                correctionAttempts.removeValue(forKey: intentID)
            }
            interactionErrors[operationID] = Self.interactionFailureMessage(
                error,
                fallback: "The move could not be completed. Check both notes and try again."
            )
            bannerMessage = interactionErrors[operationID]
            announce("The move could not be completed.")
        }
    }

    private func performReviewDestination(
        reviewID: String,
        choice: DestinationChoice
    ) async {
        switch choice {
        case let .existing(noteID):
            await performReviewRoute(reviewID: reviewID, noteID: noteID)
        case let .newNote(title, noteType, rawSpaceID):
            let spaceID: SpaceID?
            if let rawSpaceID {
                guard let parsed = SpaceID(rawValue: rawSpaceID) else { return }
                spaceID = parsed
            } else {
                spaceID = nil
            }
            await performReviewResolution(
                reviewID: reviewID,
                resolution: .create(title: title, noteType: noteType, spaceId: spaceID)
            )
        }
    }

    private func performReviewRoute(reviewID: String, noteID: String) async {
        guard let runtime,
              let user = currentUser,
              let id = NoteID(rawValue: noteID),
              let item = reviewItemsByID[reviewID],
              PresentationMapping.reviewAllowedActions(
                  for: item,
                  capture: reviewCapture(for: item)
              ).contains(.route) else { return }
        let intentID = "review.\(reviewID)|route|\(noteID)"
        let resolution: ReviewResolution
        if let existing = reviewAttempts[intentID] {
            resolution = existing.resolution
        } else {
            let context = currentAccountContext(for: user)
            do {
                let note = try await runtime.authenticatedAPI.getNote(id).note
                guard isCurrent(context), Self.fetchedNote(note, matches: id) else {
                    throw APIClientError.malformedResponse(status: 200)
                }
                guard PresentationMapping.reviewDestinationIsEligible(note) else {
                    interactionErrors["review.\(reviewID)"] =
                        "That note is closed or no longer available. Choose another note."
                    announce("That note is no longer available.")
                    return
                }
                resolution = .route(noteId: note.id, expectedRevision: note.currentRevision)
            } catch {
                guard isCurrent(context) else { return }
                interactionErrors["review.\(reviewID)"] =
                    "That note could not be refreshed. Choose it again after reconnecting."
                announce("That note could not be refreshed.")
                return
            }
        }
        await performReviewResolution(
            reviewID: reviewID,
            resolution: resolution,
            explicitIntentID: intentID
        )
    }

    private func performReviewResolution(
        reviewID: String,
        resolution: ReviewResolution,
        explicitIntentID: String? = nil
    ) async {
        guard let runtime,
              let user = currentUser,
              let id = ReviewID(rawValue: reviewID),
              let item = reviewItemsByID[reviewID],
              reviewResolution(resolution, isPermittedFor: item) else { return }
        let operationID = "review.\(reviewID)"
        guard beginInteraction(operationID) else { return }
        let context = currentAccountContext(for: user)
        let intentID = explicitIntentID ?? Self.reviewIntentID(
            operationID: operationID,
            resolution: resolution
        )
        defer { endInteraction(operationID, context: context) }

        do {
            let request: ReviewResolveRequest
            if let existing = reviewAttempts[intentID] {
                request = existing
            } else {
                request = try ReviewResolveRequest(
                    idempotencyKey: UUID().uuidString.lowercased(),
                    resolution: resolution
                )
                reviewAttempts[intentID] = request
            }
            let response = try await runtime.authenticatedAPI.resolveReviewItem(
                id,
                request: request
            )
            guard isCurrent(context),
                  response.reviewItem.id == id,
                  response.reviewItem.state != .open,
                  response.reviewItem.resolution == request.resolution else {
                throw APIClientError.malformedResponse(status: 200)
            }
            reviewQueueGeneration.invalidate()
            reviewAttempts.removeValue(forKey: intentID)
            interactionErrors.removeValue(forKey: operationID)
            destinationPickerSheet = nil
            reviewItemsByID.removeValue(forKey: reviewID)
            reviewItems.removeAll { $0.id == reviewID }

            if case let .route(noteID, _) = request.resolution {
                _ = await refreshNotesAtomically(
                    [noteID],
                    user: user,
                    runtime: runtime,
                    context: context
                )
            } else if case .create = request.resolution {
                await refreshAll()
            }
            if let captureID = item.captureId?.rawValue {
                await loadCaptureDetail(captureID: captureID, force: true)
            }
            await refreshReviewQueue(runtime: runtime, context: context)
            guard isCurrent(context) else { return }
            requestedReviewFocusID = reviewItems.first?.id
            bannerMessage = Self.reviewSuccessMessage(request.resolution)
            announce(bannerMessage ?? "Review updated.")
        } catch {
            guard isCurrent(context) else { return }
            if !Self.isAmbiguousInteractionFailure(error) {
                reviewAttempts.removeValue(forKey: intentID)
            }
            interactionErrors[operationID] = Self.interactionFailureMessage(
                error,
                fallback: "This review item could not be updated. Try the same action again."
            )
            bannerMessage = interactionErrors[operationID]
            announce("The review item could not be updated.")
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
        await applyNoteBatch([result.note], user: user, runtime: runtime, context: context)
        guard isCurrent(context) else { throw AuthenticationError.signedOut }
        await loadDeleted()
        await refreshAll()
    }

    func isSubmittingInteraction(_ operationID: String) -> Bool {
        submittingInteractionIDs.contains(operationID)
    }

    func interactionError(for operationID: String) -> String? {
        interactionErrors[operationID]
    }

    private func beginInteraction(_ operationID: String) -> Bool {
        guard submittingInteractionIDs.insert(operationID).inserted else { return false }
        interactionErrors.removeValue(forKey: operationID)
        return true
    }

    private func endInteraction(_ operationID: String, context: AccountContext) {
        guard isCurrent(context) else { return }
        submittingInteractionIDs.remove(operationID)
    }

    @discardableResult
    private func applyCaptureDetail(_ detail: CaptureDetail) -> ReceiptPresentation {
        let presentation = PresentationMapping.receipt(detail)
        capturesByID[detail.id.rawValue] = detail
        captureDetails[detail.id.rawValue] = presentation
        if let index = receipts.firstIndex(where: { $0.id == detail.id.rawValue }) {
            receipts[index] = presentation
        } else {
            receipts.insert(presentation, at: 0)
        }
        captureDetailErrors.removeValue(forKey: detail.id.rawValue)
        return presentation
    }

    private func refreshReviewQueue(runtime: Runtime, context: AccountContext) async {
        let operationGeneration = reviewQueueGeneration.beginRequest()
        do {
            let items = try await Self.fetchAllReviewItems(api: runtime.authenticatedAPI)
            let captureIDs = Self.reviewCaptureIDs(items)
            let detailEpochSnapshot = Dictionary(
                uniqueKeysWithValues: captureIDs.map {
                    ($0.rawValue, captureDetailEpochs[$0.rawValue, default: 0])
                }
            )
            let details = await Self.fetchCaptureDetails(
                captureIDs,
                api: runtime.authenticatedAPI
            )
            guard isCurrent(context),
                  reviewQueueGeneration.accepts(operationGeneration) else { return }
            let currentDetails = details.filter {
                captureDetailEpochs[$0.id.rawValue, default: 0]
                    == detailEpochSnapshot[$0.id.rawValue]
            }
            for detail in currentDetails {
                _ = applyCaptureDetail(detail)
            }
            publishReviewItems(items, captureDetails: currentDetails)
        } catch {
            guard isCurrent(context),
                  reviewQueueGeneration.accepts(operationGeneration) else { return }
            reviewError = "The review queue is unavailable. Pull to try again."
        }
    }

    private func publishReviewItems(
        _ items: [ReviewItem],
        captureDetails: [CaptureDetail]
    ) {
        let requestedCaptureIDs = Set(items.compactMap { $0.captureId?.rawValue })
        var verifiedCaptures: [String: CaptureDetail] = [:]
        for detail in captureDetails where requestedCaptureIDs.contains(detail.id.rawValue) {
            verifiedCaptures[detail.id.rawValue] = detail
        }
        reviewCapturesByID = verifiedCaptures
        var itemsByID: [String: ReviewItem] = [:]
        for item in items {
            itemsByID[item.id.rawValue] = item
        }
        reviewItemsByID = itemsByID
        reviewItems = items.map {
            PresentationMapping.review(
                $0,
                notesByID: notesByID,
                capturesByID: reviewCapturesByID
            )
        }
        reviewError = nil
    }

    private func reviewCapture(for item: ReviewItem) -> CaptureDetail? {
        item.captureId.flatMap { reviewCapturesByID[$0.rawValue] }
    }

    private func refreshNotesAtomically(
        _ noteIDs: [NoteID],
        minimumRevisions: [NoteID: Int] = [:],
        user: AuthUser,
        runtime: Runtime,
        context: AccountContext
    ) async -> Bool {
        let unique = Array(Set(noteIDs))
        do {
            let values = try await Self.fetchExactNotes(
                unique,
                api: runtime.authenticatedAPI
            )
            guard isCurrent(context),
                  values.count == unique.count,
                  Set(values.map(\.id)) == Set(unique) else { return false }
            let valuesByID = Dictionary(uniqueKeysWithValues: values.map { ($0.id, $0) })
            guard minimumRevisions.allSatisfy({ noteID, revision in
                valuesByID[noteID].map { $0.currentRevision >= revision } == true
            }) else { return false }
            await applyNoteBatch(values, user: user, runtime: runtime, context: context)
            return isCurrent(context)
        } catch {
            return false
        }
    }

    private func applyNoteBatch(
        _ values: [Note],
        user: AuthUser,
        runtime: Runtime,
        context: AccountContext
    ) async {
        guard isCurrent(context) else { return }
        var accepted: [Note] = []
        for note in values {
            if notesByID[note.id.rawValue].map({ $0.currentRevision > note.currentRevision }) != true {
                notesByID[note.id.rawValue] = note
                accepted.append(note)
            }
            if let current = notesByID[note.id.rawValue] {
                activeNoteMembership.update(
                    noteID: current.id.rawValue,
                    isActive: Self.isActiveNote(current)
                )
            }
        }
        rebuildActiveNotes()
        rebuildNoteDetails()
        for note in accepted {
            await cache(note, profileID: user.id, database: runtime.database)
        }
    }

    private func rebuildActiveNotes(
        additionalFallbacks: [String: NotePresentation] = [:]
    ) {
        var fallbacks = Dictionary(uniqueKeysWithValues: notes.map { ($0.id, $0) })
        for (noteID, presentation) in additionalFallbacks {
            fallbacks[noteID] = presentation
        }
        notes = activeNoteMembership.ids.compactMap { noteID in
            if let note = notesByID[noteID], Self.isActiveNote(note) {
                return PresentationMapping.note(note)
            }
            return fallbacks[noteID]
        }
        .sorted(by: Self.noteSort)
    }

    private nonisolated static func isActiveNote(_ note: Note) -> Bool {
        note.archivedAt == nil && note.deletedAt == nil
    }

    private func announce(_ message: String) {
        UIAccessibility.post(notification: .announcement, argument: message)
    }

    private static func correctionIntentID(
        operationID: String,
        sourceNoteID: String,
        choice: DestinationChoice
    ) -> String {
        switch choice {
        case let .existing(noteID):
            "\(operationID)|\(sourceNoteID)|existing|\(noteID)"
        case let .newNote(title, noteType, spaceID):
            "\(operationID)|\(sourceNoteID)|new|\(noteType.rawValue)|\(spaceID ?? "root")|\(title)"
        }
    }

    private static func reviewIntentID(
        operationID: String,
        resolution: ReviewResolution
    ) -> String {
        switch resolution {
        case let .route(noteID, _): "\(operationID)|route|\(noteID.rawValue)"
        case let .create(title, noteType, spaceID):
            "\(operationID)|create|\(noteType.rawValue)|\(spaceID?.rawValue ?? "root")|\(title)"
        case .keepInbox: "\(operationID)|keep-inbox"
        case .dismiss: "\(operationID)|dismiss"
        case .keepBoth: "\(operationID)|keep-both"
        case .acceptExpansion: "\(operationID)|accept-expansion"
        case .rejectExpansion: "\(operationID)|reject-expansion"
        }
    }

    private static func correctionResponse(
        _ response: DecisionCorrectionResponse,
        matches request: DecisionCorrectionRequest,
        decision: DecisionID
    ) -> Bool {
        switch response {
        case let .applied(applied):
            guard applied.decisionId == decision,
                  applied.source.noteId == request.source.noteId else { return false }
            switch (request.destination, applied.destination) {
            case let (.existingNote(requestedID, _), .existingNote(returned)):
                return returned.noteId == requestedID
            case (.newNote, .newNote):
                return true
            default:
                return false
            }
        case let .needsReview(value):
            return value.decisionId == decision
        }
    }

    nonisolated static func fetchedNote(_ note: Note, matches requestedID: NoteID) -> Bool {
        note.id == requestedID
    }

    nonisolated static func validatedCorrectionDestination(
        _ note: Note,
        matches requestedID: NoteID
    ) throws -> CorrectionDestination {
        guard fetchedNote(note, matches: requestedID) else {
            throw APIClientError.malformedResponse(status: 200)
        }
        guard PresentationMapping.reviewDestinationIsEligible(note) else {
            throw APIClientError.invalidRequest
        }
        return .existingNote(noteId: requestedID, expectedRevision: note.currentRevision)
    }

    private func reviewResolution(
        _ resolution: ReviewResolution,
        isPermittedFor item: ReviewItem
    ) -> Bool {
        let action: ReviewActionKind?
        switch resolution {
        case .route: action = .route
        case .create: action = .create
        case .keepInbox: action = .keepInbox
        case .dismiss: action = .dismiss
        case .keepBoth: action = .keepBoth
        case .acceptExpansion, .rejectExpansion: action = nil
        }
        guard let action else { return false }
        return PresentationMapping.reviewAllowedActions(
            for: item,
            capture: reviewCapture(for: item)
        ).contains(action)
    }

    private static func isAmbiguousInteractionFailure(_ error: Error) -> Bool {
        guard let error = error as? APIClientError else { return false }
        return switch error {
        case .transportFailure,
             .invalidHTTPResponse,
             .authenticationRequired,
             .responseBodyTooLarge,
             .malformedResponse:
            true
        case .invalidConfiguration,
             .invalidRequest,
             .requestBodyTooLarge:
            false
        case let .http(status, _, _, _):
            // A gateway timeout or server failure can arrive after the owner-scoped
            // transaction committed. Retain the exact body and idempotency key.
            status == 408 || status == 425 || status >= 500
        }
    }

    private nonisolated static func shouldFocusReviewAfterUndo(for error: Error) -> Bool {
        guard case let APIClientError.http(status, code, _, _) = error else { return false }
        return shouldFocusReviewAfterUndo(status: status, code: code)
    }

    nonisolated static func shouldFocusReviewAfterUndo(
        status: Int,
        code: APIErrorCode?
    ) -> Bool {
        status == 409 && code == .conflictRequiresReview
    }

    nonisolated static func undoRequestExpectedRevision(
        receiptExpectedRevision: Int,
        currentRevision: Int
    ) -> Int? {
        guard receiptExpectedRevision > 0, currentRevision >= receiptExpectedRevision else {
            return nil
        }
        return currentRevision
    }

    nonisolated static func authoritativeReviewFocusID(
        captureID: String,
        refreshedReceipt: ReceiptPresentation?
    ) -> String? {
        guard let refreshedReceipt,
              refreshedReceipt.id == captureID,
              refreshedReceipt.outcome == .needsReview,
              refreshedReceipt.actions.isEmpty,
              let reviewItemID = refreshedReceipt.reviewItemID,
              ReviewID(rawValue: reviewItemID) != nil else { return nil }
        return reviewItemID
    }

    nonisolated static func interactionFailureMessage(_ error: Error, fallback: String) -> String {
        guard let error = error as? APIClientError else { return fallback }
        switch error {
        case .transportFailure, .invalidHTTPResponse:
            return "Unfiled could not confirm the change. Try the same action again."
        case .authenticationRequired:
            return "Sign in again before changing this capture."
        case let .http(_, code, _, _):
            switch code {
            case .staleRevision:
                return "A note changed before this action finished. Refresh and try again."
            case .structureConflict:
                return "The note structure changed before this action finished. Refresh and try again."
            case .conflictRequiresReview:
                return "Nothing changed. Review the capture before choosing another action."
            case .rateLimited, .providerUnavailable:
                return "The service is busy. Try the same action again shortly."
            default:
                return fallback
            }
        case .malformedResponse, .responseBodyTooLarge:
            return "Unfiled could not confirm the result. Try the same action again."
        case .invalidConfiguration, .invalidRequest, .requestBodyTooLarge:
            return fallback
        }
    }

    private static func reviewSuccessMessage(_ resolution: ReviewResolution) -> String {
        switch resolution {
        case .route: "Filed in the selected note."
        case .create: "Filed in a new note."
        case .keepInbox: "Kept safely in Inbox."
        case .dismiss: "Dismissed from Review."
        case .keepBoth: "Kept both notes unchanged."
        case .acceptExpansion, .rejectExpansion: "Review updated."
        }
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
        captureDetails = [:]
        reviewItems = []
        searchResults = []
        archiveNotes = []
        deletedNotes = []
        revisions = [:]
        revisionSnapshots = [:]
        notesByID = [:]
        activeNoteMembership = ActiveNoteMembership()
        noteDetails = [:]
        spacesByID = [:]
        capturesByID = [:]
        reviewCapturesByID = [:]
        captureDetailEpochs = [:]
        reviewItemsByID = [:]
        reviewQueueGeneration.invalidate()
        correctionAttempts = [:]
        reviewAttempts = [:]
        undoAttempts = [:]
        navigationPath = []
        captureSheet = nil
        editorSheet = nil
        destinationPickerSheet = nil
        authStep = .email
        isLoadingLibrary = false
        isLoadingReview = false
        isSearching = false
        searchError = nil
        reviewError = nil
        captureDetailLoadingIDs = []
        captureDetailErrors = [:]
        submittingInteractionIDs = []
        interactionErrors = [:]
        requestedReviewFocusID = nil
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

    private nonisolated static func fetchExactNotes(
        _ ids: [NoteID],
        api: APIClient
    ) async throws -> [Note] {
        try await withThrowingTaskGroup(of: Note.self, returning: [Note].self) { group in
            for id in ids {
                group.addTask {
                    try await api.getNote(id).note
                }
            }
            var values: [Note] = []
            values.reserveCapacity(ids.count)
            for try await value in group {
                values.append(value)
            }
            return values
        }
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

    private nonisolated static func fetchCaptureDetails(
        _ ids: [CaptureID],
        api: APIClient
    ) async -> [CaptureDetail] {
        var details: [CaptureDetail] = []
        for start in stride(from: 0, to: ids.count, by: 12) {
            guard !Task.isCancelled else { break }
            let end = min(start + 12, ids.count)
            let batch = await withTaskGroup(
                of: CaptureDetail?.self,
                returning: [CaptureDetail].self
            ) { group in
                for id in ids[start ..< end] {
                    group.addTask {
                        guard let detail = try? await api.getCapture(id).capture,
                              detail.id == id else { return nil }
                        return detail
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

    private nonisolated static func reviewCaptureIDs(_ items: [ReviewItem]) -> [CaptureID] {
        var seen = Set<String>()
        return items.compactMap { item in
            guard let captureID = item.captureId,
                  seen.insert(captureID.rawValue).inserted else { return nil }
            return captureID
        }
    }

    private nonisolated static func fetchAllNotes(
        api: APIClient,
        archive: ArchiveFilter = .exclude,
        deleted: DeletedFilter = .exclude
    ) async throws -> [NoteSummary] {
        var items: [NoteSummary] = []
        var cursor: String?
        var seen = Set<String>()
        var identities = PaginationIdentityValidator()
        for _ in 0 ..< 200 {
            let page = try await api.listNotes(
                .init(cursor: cursor, limit: 100, archive: archive, deleted: deleted)
            )
            try identities.accept(page.items.map { $0.id.rawValue })
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
        var identities = PaginationIdentityValidator()
        for _ in 0 ..< 200 {
            let page = try await api.listSpaces(.init(cursor: cursor, limit: 100))
            try identities.accept(page.items.map { $0.id.rawValue })
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
        var identities = PaginationIdentityValidator()
        for _ in 0 ..< 200 {
            let page = try await api.listCaptures(.init(cursor: cursor, limit: 100))
            try identities.accept(page.items.map { $0.id.rawValue })
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
        var identities = PaginationIdentityValidator()
        for _ in 0 ..< 200 {
            let page = try await api.listReviewItems(.init(cursor: cursor, limit: 100))
            try identities.accept(page.items.map { $0.id.rawValue })
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
        var identities = PaginationIdentityValidator()
        for _ in 0 ..< 200 {
            try Task.checkCancellation()
            let page = try await api.searchNotes(
                .init(query: query, archive: archive, cursor: cursor, limit: 100)
            )
            try identities.accept(page.items.map { $0.noteId.rawValue })
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
        var identities = PaginationIdentityValidator()
        for _ in 0 ..< 200 {
            let page = try await api.listNoteRevisions(id, cursor: cursor, limit: 100)
            try identities.accept(page.items.map { $0.id.rawValue })
            items.append(contentsOf: page.items)
            guard let next = try validatedNextCursor(page.pageInfo, seen: &seen) else {
                return items
            }
            cursor = next
        }
        throw PaginationError.pageLimitExceeded
    }

    nonisolated static func validatedNextCursor(
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
    case duplicateItemIdentifier
    case inconsistentPageInfo
    case pageLimitExceeded
}
