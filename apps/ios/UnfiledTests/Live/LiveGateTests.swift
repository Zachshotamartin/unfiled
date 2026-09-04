import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import Unfiled

/// The live gate: the app's own model performs every real operation against a deployed origin
/// with a synthetic account. It runs only when `UNFILED_LIVE_GATE=1` and
/// `UNFILED_LIVE_GATE_API_BASE_URL` are in the test environment (pass them to xcodebuild as
/// `TEST_RUNNER_UNFILED_LIVE_GATE=1` and `TEST_RUNNER_UNFILED_LIVE_GATE_API_BASE_URL=…`).
/// With `UNFILED_LIVE_GATE_OPENAI_API_KEY` the organizer runs for the synthetic account, so the
/// review, undo, and filed-note paths are exercised; without it those steps fail as "no_key".
/// `UNFILED_LIVE_GATE_SUPABASE_URL` and `UNFILED_LIVE_GATE_SUPABASE_SERVICE_ROLE_KEY` are required:
/// a deployment that confirms addresses emails six digits before a new account can sign in, so the
/// gate confirms its own synthetic account through Supabase's admin API. A run without them fails
/// at once naming what is missing, and the gate runner refuses to start before that.
/// Output is content-free: step names, booleans, counts, and error codes.
@MainActor
final class LiveGateTests: XCTestCase {
    private static let environment = ProcessInfo.processInfo.environment
    private static var enabled: Bool { environment["UNFILED_LIVE_GATE"] == "1" }
    private static var organizerKey: String? {
        let value = environment["UNFILED_LIVE_GATE_OPENAI_API_KEY"] ?? ""
        return value.isEmpty ? nil : value
    }

    /// Six digits, so a refusal comes from the provider rather than from request validation.
    private static let wrongVerificationCode = "000000"

    private var model: AppModel!
    private var admin: LiveGateSupabaseAdmin!
    private var api: APIClient!
    private var steps: [(name: String, ok: Bool, detail: String)] = []

    override func setUp() async throws {
        try XCTSkipUnless(Self.enabled, "live gate not requested")
        // A run that cannot confirm its own address would create an account it can never sign in
        // to, so a missing value fails here, named, rather than halfway through the gate.
        let configuration = try LiveGateSupabaseAdmin.Configuration.read(from: Self.environment).get()
        admin = LiveGateSupabaseAdmin(configuration: configuration, transport: LiveGateSupabaseAdmin.urlSession)
        let defaults = UserDefaults(suiteName: "LiveGateTests.\(UUID().uuidString)")!
        model = AppModel(bundle: Bundle.main, userDefaults: defaults)
        try XCTSkipIf(model.apiHostLabel == "Unavailable", "no runtime: set UNFILED_LIVE_GATE_API_BASE_URL")
        // The app's own client, which is how the gate reads an answer the model does not carry yet.
        let baseURL = try XCTUnwrap(URL(string: Self.environment["UNFILED_LIVE_GATE_API_BASE_URL"] ?? ""))
        api = try APIClient(baseURL: baseURL)
    }

    private func step(_ name: String, _ ok: Bool, _ detail: String = "", file: StaticString = #filePath, line: UInt = #line) {
        steps.append((name, ok, detail))
        print("\(ok ? "pass" : "FAIL")  \(name)\(detail.isEmpty ? "" : "  \(detail)")")
        XCTAssertTrue(ok, "\(name) \(detail)", file: file, line: line)
    }

    /// Polls a condition on the main actor; the model publishes state after each reply.
    private func waitUntil(_ timeout: TimeInterval = 240, every: TimeInterval = 3, _ condition: @MainActor () async -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await condition() { return true }
            try? await Task.sleep(for: .seconds(every))
        }
        return await condition()
    }

    /// A small real JPEG, drawn here so the gate never reads a file from the phone.
    private static func gatePhoto() throws -> Data {
        let width = 96, height = 64
        let context = try XCTUnwrap(CGContext(
            data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ))
        context.setFillColor(CGColor(red: 0.78, green: 0.71, blue: 0.9, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        context.setFillColor(CGColor(red: 0.24, green: 0.47, blue: 0.27, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: width, height: 22))
        let image = try XCTUnwrap(context.makeImage())
        let data = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(data, UTType.jpeg.identifier as CFString, 1, nil))
        CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.85] as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { throw LiveGateFailure.fixture }
        return data as Data
    }

    private enum LiveGateFailure: Error { case fixture }

    /// Saves a capture the way the composer does: prepare (which loads the generation), save, close.
    private func capture(_ content: String) async throws {
        await model.prepareCapture(source: .mobile)
        let generation = model.captureSheet?.composerGeneration ?? 1
        try await model.saveCapture(content: content, source: .mobile, composerGeneration: generation)
        model.captureSheet = nil
    }

    /// Writes a note through the editor's own create path, which is how a note exists without
    /// waiting on the organizer. The note lifecycle steps below run against it.
    private func writeNote(title: String, body: String, type: NoteType = .generic) async throws {
        try await model.saveNote(
            NoteEditorDraft(
                noteID: nil,
                title: title,
                bodyMarkdown: body,
                type: type,
                privacy: .aiAssisted,
                spaceID: nil
            ),
            expectedRevision: nil
        )
    }

    /// The auth endpoints rate-limit one address; a run right after another waits for the window
    /// the server names (bounded) instead of reporting a false failure.
    private func signUpWaitingForRateLimit(email: String, password: String) async throws -> LiveGateSignUpAnswer {
        let request = try AuthPasswordRequest(email: email, password: password)
        for attempt in 0 ..< 3 {
            do {
                return try await api.post("/auth/sign-up", body: request, authenticated: false, as: LiveGateSignUpAnswer.self)
            } catch let APIClientError.http(status, _, _, retryAfterSeconds) where status == 429 && attempt < 2 {
                let wait = min(retryAfterSeconds ?? 60, 360)
                print("wait  auth.sign_up rate limited; retrying in \(wait)s")
                try await Task.sleep(for: .seconds(wait + 1))
            }
        }
        return try await api.post("/auth/sign-up", body: request, authenticated: false, as: LiveGateSignUpAnswer.self)
    }

    /// A well-formed but wrong code must be refused, and must never hand back a session.
    private func wrongCodeRefused(email: String) async -> Bool {
        do {
            _ = try await api.post(
                "/auth/verify",
                body: LiveGateVerifyRequest(email: email, code: Self.wrongVerificationCode),
                authenticated: false,
                as: LiveGateSignUpAnswer.self
            )
            return false
        } catch let APIClientError.http(status, _, _, _) {
            return (400 ..< 500).contains(status)
        } catch {
            return false
        }
    }

    func testLiveGate() async throws {
        let stamp = String(Int(Date().timeIntervalSince1970), radix: 36)
        let email = "gate-phone-\(stamp)@example.com"
        let password = "Gate-\(UUID().uuidString.prefix(20))-1"

        // Account. Sign-up gives one of two answers and the same build handles both: a deployment
        // that confirms addresses asks for a code, which the gate answers by confirming its own
        // synthetic account through Supabase admin and then signing in.
        let mode = await admin.deploymentConfirmsAddresses()
        step("supabase.admin_reachable", mode.ok, "status \(mode.status)")
        guard mode.ok else { return }
        let session: AuthSession
        switch try await signUpWaitingForRateLimit(email: email, password: password) {
        case let .session(issued):
            step("auth.sign_up", !mode.confirmsAddresses, "verificationRequired false")
            guard !mode.confirmsAddresses else { return }
            session = issued
        case .verificationRequired:
            step("auth.sign_up", mode.confirmsAddresses, "verificationRequired true")
            guard mode.confirmsAddresses else { return }
            step("auth.wrong_code_refused", await wrongCodeRefused(email: email))
            // The gate is a privileged caller, not a new hole: it confirms its own synthetic
            // address the way an operator would, and the product keeps no endpoint that would let
            // anyone else skip the code.
            let confirmed = await admin.confirmAddress(email)
            step("auth.address_confirmed_by_admin", confirmed.ok, "found \(confirmed.found) status \(confirmed.status)")
            guard confirmed.ok else { return }
            session = try await model.signIn(try AuthPasswordRequest(email: email, password: password))
        }
        step("auth.session_issued", !session.accessToken.isEmpty)
        await model.acceptVerifiedSession(session)
        step("auth.signed_in_phase", model.phase == .signedIn, "\(model.phase)")
        await model.refreshAll()
        step("refresh.empty_account", model.notes.isEmpty && model.receipts.isEmpty && model.reviewItems.isEmpty, "notes \(model.notes.count) receipts \(model.receipts.count) reviews \(model.reviewItems.count)")

        // Provider key and settings (organizer-dependent steps need the key)
        await model.loadAISettings()
        step("settings.loaded", model.aiSettings != nil, model.aiSettingsError ?? "")
        if let organizerKey = Self.organizerKey {
            let saved = await model.saveProviderKey(organizerKey, provider: .openai)
            step("provider_key.saved", saved, model.providerKeyErrors[.openai] ?? "")
            if let settings = model.aiSettings {
                var draft = AISettingsDraft(settings: settings)
                draft.providerMode = .byok
                draft.byokProvider = .openai
                let ok = await model.saveAISettings(draft)
                step("settings.byok_saved", ok, model.aiSettingsError ?? "")
            }
        } else {
            step("provider_key.saved", false, "no_key: set UNFILED_LIVE_GATE_OPENAI_API_KEY")
        }

        // A note written in the editor, which is the only way a note exists without the organizer
        try await writeNote(
            title: "Gate note \(stamp)",
            body: "kitchen tap plumber"
        )
        let noteArrived = await waitUntil(60) { self.model.notes.contains { $0.title.contains("Gate note") } }
        step("note.written_in_editor", noteArrived, "notes \(model.notes.count)")
        guard let writtenNote = model.notes.first(where: { $0.title.contains("Gate note") }) else { return }

        // Edit the note: the editor closes at once and the reply confirms the title
        await model.presentEditor(noteID: writtenNote.id)
        step("editor.opened", model.editorSheet != nil)
        if let sheet = model.editorSheet {
            var draft = sheet.draft
            draft.title = "Gate note \(stamp) v2"
            try await model.saveNote(draft, expectedRevision: sheet.currentRevision)
            step("note.saved_title", model.noteDetail(writtenNote.id)?.title == draft.title, model.noteDetail(writtenNote.id)?.title ?? "nil")
            step("editor.closed_after_save", model.editorSheet == nil)
        }

        // A second note, in list form, so the checklist surfaces have something to read
        try await writeNote(
            title: "Gate list \(stamp)",
            body: "- [ ] milk\n- [ ] eggs\n- [ ] bread",
            type: .list
        )
        let listArrived = await waitUntil(60) { self.model.notes.count >= 2 }
        step("note.second_written", listArrived, "notes \(model.notes.count)")

        // Archive and restore
        try await model.setArchived(noteID: writtenNote.id, archived: true)
        step("note.archived", model.isArchived(writtenNote.id))
        try await model.setArchived(noteID: writtenNote.id, archived: false)
        step("note.unarchived", !model.isArchived(writtenNote.id))

        // Delete and restore from Recently deleted
        do {
            try await model.deleteNote(noteID: writtenNote.id)
            step("note.deleted", !model.notes.contains { $0.id == writtenNote.id }, model.bannerMessage ?? "")
        } catch {
            step("note.deleted", false, "\(error)")
        }
        await model.loadDeleted()
        step("deleted.listed", model.deletedNotes.contains { $0.id == writtenNote.id }, "deleted \(model.deletedNotes.count)")
        do {
            try await model.restoreDeleted(noteID: writtenNote.id)
            step("note.restored", model.notes.contains { $0.id == writtenNote.id })
        } catch {
            step("note.restored", false, "\(error)")
        }

        // Search over the private note
        model.search(SearchRequest(query: "plumber", includesArchived: false))
        let found = await waitUntil(60) { !self.model.searchResults.isEmpty }
        step("search.finds_private_note", found, "results \(model.searchResults.count)")

        // An AI-assisted capture: organized with a key, failed without one
        try await capture("Groceries gate \(stamp): oat milk, bananas")
        let receiptArrived = await waitUntil(30) { self.model.receipts.contains { $0.original.contains("Groceries gate") } }
        step("capture.receipt_row_at_once", receiptArrived, "receipts \(model.receipts.count)")
        let settled = await waitUntil(300, every: 10) {
            await self.model.refreshAll()
            guard let receipt = self.model.receipts.first(where: { $0.original.contains("Groceries gate") }) else { return false }
            return !receipt.pending
        }
        let receipt = model.receipts.first { $0.original.contains("Groceries gate") }
        if Self.organizerKey != nil {
            step("capture.organized", settled && (receipt?.outcome != nil), "outcome \(receipt?.outcome.map { "\($0)" } ?? "nil") retryable \(receipt?.retryable ?? false)")
            if receipt?.outcome == .needsReview, let reviewID = receipt?.reviewItemID {
                step("review.item_open_on_phone", model.reviewItems.contains { $0.id == reviewID }, "reviews \(model.reviewItems.count)")
                model.showReview(reviewID: reviewID)
                step("review.page_pushed", model.navigationPath.last == .review(reviewID))
                await model.handleReviewAction(reviewID: reviewID, action: .decide)
                let decided = await waitUntil(60) { !self.model.reviewItems.contains { $0.id == reviewID } }
                step("review.decided", decided, model.bannerMessage ?? "")
                await model.loadCaptureDetail(captureID: receipt!.id, force: true)
                let updated = model.captureDetail(receipt!.id)
                step("receipt.updated_after_decision", updated?.outcome == .createdNote || updated?.outcome == .addedToNote, "\(updated?.outcome.map { "\($0)" } ?? "nil")")
            }
            if let filed = model.captureDetail(receipt?.id ?? ""), let undo = filed.actions.compactMap({ action -> (String, Int)? in
                if case let .undo(mutationID, expectedRevision) = action { return (mutationID, expectedRevision) }
                return nil
            }).first {
                await model.undoReceipt(captureID: filed.id, mutationID: undo.0, expectedRevision: undo.1)
                step("receipt.undo", model.interactionError(for: "receipt.undo.\(filed.id)") == nil, model.interactionError(for: "receipt.undo.\(filed.id)") ?? "")
            }
        } else {
            step("capture.keyless_fails_retryable", settled && receipt?.retryable == true, "retryable \(receipt?.retryable ?? false)")
            if let receipt {
                await model.retryCapture(captureID: receipt.id)
                step("capture.retry_accepted", model.bannerMessage?.contains("could not be retried") != true, model.bannerMessage ?? "")
            }
            step("capture.organizer_path", false, "no_key")
        }

        // Edit text on a retryable or reviewed capture replaces it
        if let receipt, receipt.canEditText {
            await model.editCapture(captureID: receipt.id)
            step("capture.edit_opens_composer_prefilled", model.captureSheet?.replacingCaptureID == receipt.id)
            model.captureSheet = nil
        }

        // Organize again with directions: the old row leaves, a new one organizes, and the
        // Inbox shows only what needs the owner.
        if let receipt, receipt.canOrganizeAgain {
            await model.organizeAgain(captureID: receipt.id, guidance: "start a new note for this")
            let replaced = await waitUntil(20) { !self.model.receipts.contains { $0.id == receipt.id } }
            step("capture.organize_again_replaces_row", replaced, "receipts \(model.receipts.count)")
            let organizedAgain = await waitUntil(300, every: 10) {
                await self.model.refreshAll()
                return self.model.receipts.allSatisfy { !$0.pending }
            }
            step("capture.organize_again_settles", organizedAgain, "pending \(model.receipts.filter(\.pending).count)")
            let filedLeavesInbox = model.receipts.filter(InboxAttention.needsYou).count <= model.reviewItems.count + model.receipts.filter(\.retryable).count
            step("inbox.holds_only_what_needs_you", filedLeavesInbox, "needsYou \(model.receipts.filter(InboxAttention.needsYou).count)")
        }
        if let stray = model.receipts.first(where: { InboxAttention.needsYou($0) && !$0.pending }) {
            await model.deleteCapture(captureID: stray.id)
            let gone = await waitUntil(20) { !self.model.receipts.contains { $0.id == stray.id } }
            step("capture.delete_removes_row", gone, model.bannerMessage ?? "")
        }

        // A photo capture: prepared like the composer does, uploaded before the capture, filed by
        // reference, and read back through the note.
        let photo = try Self.gatePhoto()
        let prepared = try CaptureImagePreparation.prepare(imageData: photo)
        let attachment = CaptureAttachmentDraft(
            id: try await PrefixedULIDGenerator().next(.attachment), kind: .image, mediaType: prepared.mediaType,
            bytes: prepared.data, width: prepared.width, height: prepared.height, durationMs: nil
        )
        await model.prepareCapture(source: .mobile)
        let photoGeneration = model.captureSheet?.composerGeneration ?? 1
        try await model.saveCapture(
            content: CaptureComposerRules.rawContent(content: "", kinds: [.image]),
            source: .mobile, composerGeneration: photoGeneration, attachments: [attachment]
        )
        model.captureSheet = nil
        let photoReceiptArrived = await waitUntil(30) { self.model.receipts.contains { $0.original == "Photo" } }
        step("photo.receipt_row_at_once", photoReceiptArrived, "receipts \(model.receipts.count)")
        let photoSettled = await waitUntil(300, every: 10) {
            await self.model.refreshAll()
            guard let receipt = self.model.receipts.first(where: { $0.original == "Photo" }) else { return false }
            return !receipt.pending
        }
        let photoReceipt = model.receipts.first { $0.original == "Photo" }
        let readBack = await model.attachmentBytes(id: attachment.id)
        step("photo.bytes_read_back_unchanged", readBack == prepared.data, "bytes \(readBack?.count ?? 0)")
        if Self.organizerKey != nil {
            step("photo.organized", photoSettled && photoReceipt?.outcome != nil, "outcome \(photoReceipt?.outcome.map { "\($0)" } ?? "nil")")
            if let noteID = photoReceipt?.destinationNoteID {
                await model.refreshAll()
                let body = model.noteDetail(noteID)?.bodyMarkdown ?? ""
                step("photo.filed_note_references_photo", body.contains("unfiled-attachment:\(attachment.id)"), "note \(noteID)")
            } else {
                step("photo.filed_note_references_photo", photoReceipt?.outcome == .needsReview, "no destination; outcome \(photoReceipt?.outcome.map { "\($0)" } ?? "nil")")
            }
        } else {
            step("photo.keyless_fails_retryable", photoSettled && photoReceipt?.retryable == true, "retryable \(photoReceipt?.retryable ?? false)")
        }

        // Sign out and delete the account
        await model.signOut()
        step("auth.signed_out", model.phase == .signedOut, "\(model.phase)")
        let back = try await model.signIn(try AuthPasswordRequest(email: email, password: password))
        await model.acceptVerifiedSession(back)
        let deleted = await model.deleteAccount()
        step("account.deleted", deleted, model.accountDeletionError ?? "")

        let failed = steps.filter { !$0.ok }
        print("live gate (phone): \(steps.count) steps, \(failed.count) failed")
    }
}


/// Sign-up gives one of two answers, and every client has to handle both from the same build: a
/// deployment that confirms addresses asks for a six digit code, and one that confirms nothing
/// signs the owner straight in.
enum LiveGateSignUpAnswer: Decodable {
    case session(AuthSession)
    case verificationRequired

    private enum CodingKeys: String, CodingKey { case verificationRequired }

    init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        if try container.decodeIfPresent(Bool.self, forKey: .verificationRequired) == true {
            self = .verificationRequired
        } else {
            self = .session(try AuthSession(from: decoder))
        }
    }
}

/// The code a deployment that confirms addresses expects back.
struct LiveGateVerifyRequest: Encodable {
    let email: String
    let code: String
}

/// Names what a run needs before it can create an account it could sign in to.
struct LiveGateConfigurationError: Error, LocalizedError, Equatable {
    let missing: [String]

    var errorDescription: String? {
        "live gate cannot start: set \(missing.joined(separator: " and ")). A deployment that "
            + "confirms addresses emails a code before a new account can sign in, so the gate "
            + "confirms its own synthetic account through Supabase admin."
    }
}

/// Supabase admin access for the phone gate. Production confirms a new address by emailing six
/// digits, so the synthetic account a run creates cannot sign in on its own. The gate is a
/// privileged caller: it confirms its own account through Supabase's own admin API with a service
/// role key that lives only in the gate environment, which is why the product never grew an
/// endpoint that would let anyone else skip verification. Every reply leaves as a status and a
/// boolean, so the gate stays content-free.
struct LiveGateSupabaseAdmin: Sendable {
    /// One page of accounts holds an address created seconds ago, and the bound keeps a lookup
    /// from walking a whole project.
    static let pageSize = 200
    static let pages = 3

    typealias Transport = @Sendable (URLRequest) async throws -> (Data, Int)

    static let urlSession: Transport = { request in
        let (data, response) = try await URLSession.shared.data(for: request)
        return (data, (response as? HTTPURLResponse)?.statusCode ?? 0)
    }

    struct Configuration: Equatable, Sendable {
        static let urlVariable = "UNFILED_LIVE_GATE_SUPABASE_URL"
        static let serviceRoleKeyVariable = "UNFILED_LIVE_GATE_SUPABASE_SERVICE_ROLE_KEY"

        let url: URL
        let serviceRoleKey: String

        /// Reads both values, naming every one that is missing so one run reports the whole gap.
        static func read(from environment: [String: String]) -> Result<Configuration, LiveGateConfigurationError> {
            let resolved = absoluteHTTPURL(environment[urlVariable] ?? "")
            let serviceRoleKey = (environment[serviceRoleKeyVariable] ?? "")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            var missing: [String] = []
            if resolved == nil { missing.append(urlVariable) }
            if serviceRoleKey.isEmpty { missing.append(serviceRoleKeyVariable) }
            guard let resolved, missing.isEmpty else {
                return .failure(LiveGateConfigurationError(missing: missing))
            }
            return .success(Configuration(url: resolved, serviceRoleKey: serviceRoleKey))
        }

        private static func absoluteHTTPURL(_ value: String) -> URL? {
            var trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasSuffix("/") { trimmed.removeLast() }
            guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
                  scheme == "https" || scheme == "http", url.host?.isEmpty == false else { return nil }
            return url
        }
    }

    /// What a deployment does with a new address, as the provider reports it.
    struct Mode: Equatable, Sendable {
        let ok: Bool
        let status: Int
        let confirmsAddresses: Bool
    }

    /// What became of one address, with nothing that identifies it.
    struct Outcome: Equatable, Sendable {
        let ok: Bool
        let found: Bool
        let status: Int
    }

    let configuration: Configuration
    let transport: Transport

    /// Whether this deployment confirms new addresses. The provider is the authority, so the gate
    /// asks it rather than inferring the answer from the sign-up it is about to assert.
    func deploymentConfirmsAddresses() async -> Mode {
        let read = await perform("GET", "/auth/v1/settings", as: ProviderSettings.self)
        guard read.status == 200, let settings = read.value else {
            return Mode(ok: false, status: read.status, confirmsAddresses: false)
        }
        return Mode(ok: true, status: read.status, confirmsAddresses: !settings.mailerAutoconfirm)
    }

    /// Confirms one address so the account it belongs to can sign in.
    func confirmAddress(_ email: String) async -> Outcome {
        let address = email.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        var status = 0
        for page in 1 ... Self.pages {
            let listed = await perform("GET", accountsPath(page: page, address: address), as: AccountPage.self)
            status = listed.status
            guard listed.status == 200, let accounts = listed.value?.users else { break }
            if let match = accounts.first(where: { $0.email?.lowercased() == address }) {
                let body = try? JSONEncoder().encode(ConfirmAddressRequest(confirmAddress: true))
                let updated = await perform("PUT", "/auth/v1/admin/users/\(match.id)", body: body, as: Account.self)
                let confirmed = updated.status == 200 && updated.value?.emailConfirmedAt != nil
                return Outcome(ok: confirmed, found: true, status: updated.status)
            }
            // A short page is the last page, so an address that is not on it does not exist.
            if accounts.count < Self.pageSize { break }
        }
        return Outcome(ok: false, found: false, status: status)
    }

    private func accountsPath(page: Int, address: String) -> String {
        var components = URLComponents()
        components.path = "/auth/v1/admin/users"
        components.queryItems = [
            URLQueryItem(name: "page", value: "\(page)"),
            URLQueryItem(name: "per_page", value: "\(Self.pageSize)"),
            URLQueryItem(name: "filter", value: address)
        ]
        return components.string ?? "/auth/v1/admin/users"
    }

    private func perform<Response: Decodable>(_ method: String, _ path: String, body: Data? = nil,
                                              as type: Response.Type) async -> (value: Response?, status: Int) {
        guard let url = URL(string: configuration.url.absoluteString + path) else { return (nil, 0) }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "accept")
        request.setValue(configuration.serviceRoleKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(configuration.serviceRoleKey)", forHTTPHeaderField: "authorization")
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "content-type")
        }
        do {
            let (data, status) = try await transport(request)
            return (try? JSONDecoder().decode(Response.self, from: data), status)
        } catch {
            // The project is unreachable. The gate records a failed step rather than an exception,
            // so a network problem reads like every other failure in the run.
            return (nil, 0)
        }
    }

    private struct ProviderSettings: Decodable {
        let mailerAutoconfirm: Bool
        private enum CodingKeys: String, CodingKey { case mailerAutoconfirm = "mailer_autoconfirm" }
    }

    private struct Account: Decodable {
        let id: String
        let email: String?
        let emailConfirmedAt: String?
        private enum CodingKeys: String, CodingKey {
            case id, email
            case emailConfirmedAt = "email_confirmed_at"
        }
    }

    private struct AccountPage: Decodable {
        let users: [Account]
    }

    private struct ConfirmAddressRequest: Encodable {
        let confirmAddress: Bool
        private enum CodingKeys: String, CodingKey { case confirmAddress = "email_confirm" }
    }
}

/// The admin caller runs without a deployment, so the behaviour the live gate leans on is covered
/// by the ordinary test run: a run that is missing configuration names what it needs, and an
/// address counts as confirmed only when the provider says it is.
final class LiveGateSupabaseAdminTests: XCTestCase {
    private struct StubReply: Sendable {
        let method: String
        let path: String
        var status: Int = 200
        var json: String = "{}"
        var unreachable: Bool = false
    }

    private enum StubFailure: Error { case noReply, unreachable }

    /// A stubbed project: replies are matched by method and path, and every request is kept.
    private actor StubProject {
        private let replies: [StubReply]
        private(set) var requests: [URLRequest] = []

        init(_ replies: [StubReply]) { self.replies = replies }

        func reply(to request: URLRequest) throws -> (Data, Int) {
            requests.append(request)
            let method = request.httpMethod ?? "GET"
            let url = request.url?.absoluteString ?? ""
            guard let match = replies.first(where: { $0.method == method && url.contains($0.path) }) else {
                throw StubFailure.noReply
            }
            if match.unreachable { throw StubFailure.unreachable }
            return (Data(match.json.utf8), match.status)
        }
    }

    private func caller(_ replies: [StubReply]) throws -> (admin: LiveGateSupabaseAdmin, project: StubProject) {
        let url = try XCTUnwrap(URL(string: "https://project.supabase.co"))
        let project = StubProject(replies)
        let configuration = LiveGateSupabaseAdmin.Configuration(url: url, serviceRoleKey: "service-role-key")
        let admin = LiveGateSupabaseAdmin(configuration: configuration) { request in
            try await project.reply(to: request)
        }
        return (admin, project)
    }

    private static let listedGateAccount = StubReply(
        method: "GET",
        path: "/auth/v1/admin/users?page=1",
        json: #"{"users":[{"id":"other-id","email":"someone@example.com"},{"id":"gate-id","email":"gate@example.com"}]}"#
    )

    func testConfigurationNamesEveryMissingVariable() throws {
        let read = LiveGateSupabaseAdmin.Configuration.read(from: [:])
        guard case let .failure(failure) = read else { return XCTFail("expected a failure") }
        XCTAssertEqual(failure.missing, [
            LiveGateSupabaseAdmin.Configuration.urlVariable,
            LiveGateSupabaseAdmin.Configuration.serviceRoleKeyVariable
        ])
        let message = try XCTUnwrap(failure.errorDescription)
        XCTAssertTrue(message.contains(LiveGateSupabaseAdmin.Configuration.urlVariable), message)
        XCTAssertTrue(message.contains(LiveGateSupabaseAdmin.Configuration.serviceRoleKeyVariable), message)
    }

    func testConfigurationNamesOnlyTheServiceRoleKeyWhenTheProjectURLIsPresent() {
        let read = LiveGateSupabaseAdmin.Configuration.read(from: [
            LiveGateSupabaseAdmin.Configuration.urlVariable: "https://project.supabase.co",
            LiveGateSupabaseAdmin.Configuration.serviceRoleKeyVariable: "   "
        ])
        guard case let .failure(failure) = read else { return XCTFail("expected a failure") }
        XCTAssertEqual(failure.missing, [LiveGateSupabaseAdmin.Configuration.serviceRoleKeyVariable])
    }

    func testConfigurationRejectsAProjectURLThatIsNotAnAbsoluteHTTPAddress() {
        let read = LiveGateSupabaseAdmin.Configuration.read(from: [
            LiveGateSupabaseAdmin.Configuration.urlVariable: "project.supabase.co",
            LiveGateSupabaseAdmin.Configuration.serviceRoleKeyVariable: "service-role-key"
        ])
        guard case let .failure(failure) = read else { return XCTFail("expected a failure") }
        XCTAssertEqual(failure.missing, [LiveGateSupabaseAdmin.Configuration.urlVariable])
    }

    func testConfigurationTrimsTheValuesAndTheTrailingSlashTheConsoleCopies() {
        let read = LiveGateSupabaseAdmin.Configuration.read(from: [
            LiveGateSupabaseAdmin.Configuration.urlVariable: " https://project.supabase.co/ ",
            LiveGateSupabaseAdmin.Configuration.serviceRoleKeyVariable: " service-role-key \n"
        ])
        guard case let .success(configuration) = read else { return XCTFail("expected a configuration") }
        XCTAssertEqual(configuration.url.absoluteString, "https://project.supabase.co")
        XCTAssertEqual(configuration.serviceRoleKey, "service-role-key")
    }

    func testDeploymentConfirmsAddressesWhenTheProviderDoesNotAutoconfirm() async throws {
        let (admin, project) = try caller([
            StubReply(method: "GET", path: "/auth/v1/settings", json: #"{"mailer_autoconfirm":false}"#)
        ])
        let mode = await admin.deploymentConfirmsAddresses()
        XCTAssertEqual(mode, LiveGateSupabaseAdmin.Mode(ok: true, status: 200, confirmsAddresses: true))
        let requests = await project.requests
        let request = try XCTUnwrap(requests.first)
        XCTAssertEqual(request.value(forHTTPHeaderField: "apikey"), "service-role-key")
        XCTAssertEqual(request.value(forHTTPHeaderField: "authorization"), "Bearer service-role-key")
    }

    func testDeploymentConfirmsNothingWhenTheProviderAutoconfirms() async throws {
        let (admin, _) = try caller([
            StubReply(method: "GET", path: "/auth/v1/settings", json: #"{"mailer_autoconfirm":true}"#)
        ])
        let mode = await admin.deploymentConfirmsAddresses()
        XCTAssertEqual(mode, LiveGateSupabaseAdmin.Mode(ok: true, status: 200, confirmsAddresses: false))
    }

    func testDeploymentModeFailsRatherThanGuessingWhenTheSettingCannotBeRead() async throws {
        let (admin, _) = try caller([
            StubReply(method: "GET", path: "/auth/v1/settings", status: 401, json: #"{"message":"unauthorized"}"#)
        ])
        let mode = await admin.deploymentConfirmsAddresses()
        XCTAssertEqual(mode, LiveGateSupabaseAdmin.Mode(ok: false, status: 401, confirmsAddresses: false))
    }

    func testDeploymentModeFailsWithoutThrowingWhenTheProjectIsUnreachable() async throws {
        let (admin, _) = try caller([
            StubReply(method: "GET", path: "/auth/v1/settings", unreachable: true)
        ])
        let mode = await admin.deploymentConfirmsAddresses()
        XCTAssertEqual(mode, LiveGateSupabaseAdmin.Mode(ok: false, status: 0, confirmsAddresses: false))
    }

    func testConfirmAddressConfirmsTheAccountTheProviderReportsAsConfirmed() async throws {
        let (admin, project) = try caller([
            Self.listedGateAccount,
            StubReply(
                method: "PUT",
                path: "/auth/v1/admin/users/gate-id",
                json: #"{"id":"gate-id","email":"gate@example.com","email_confirmed_at":"2026-09-03T00:00:00Z"}"#
            )
        ])
        let outcome = await admin.confirmAddress("Gate@Example.com")
        XCTAssertEqual(outcome, LiveGateSupabaseAdmin.Outcome(ok: true, found: true, status: 200))
        let requests = await project.requests
        let body = try XCTUnwrap(requests.last?.httpBody)
        XCTAssertEqual(try JSONSerialization.jsonObject(with: body) as? [String: Bool], ["email_confirm": true])
    }

    func testConfirmAddressReportsAnAbsentAccountWithoutWriting() async throws {
        let (admin, project) = try caller([
            StubReply(
                method: "GET",
                path: "/auth/v1/admin/users?page=1",
                json: #"{"users":[{"id":"other-id","email":"someone@example.com"}]}"#
            )
        ])
        let outcome = await admin.confirmAddress("gate@example.com")
        XCTAssertEqual(outcome, LiveGateSupabaseAdmin.Outcome(ok: false, found: false, status: 200))
        let requests = await project.requests
        XCTAssertEqual(requests.count, 1)
    }

    func testConfirmAddressFailsWhenTheProviderDoesNotConfirmTheAddress() async throws {
        let (admin, _) = try caller([
            Self.listedGateAccount,
            StubReply(
                method: "PUT",
                path: "/auth/v1/admin/users/gate-id",
                json: #"{"id":"gate-id","email":"gate@example.com","email_confirmed_at":null}"#
            )
        ])
        let outcome = await admin.confirmAddress("gate@example.com")
        XCTAssertEqual(outcome, LiveGateSupabaseAdmin.Outcome(ok: false, found: true, status: 200))
    }

    func testSignUpAnswerReadsACodeRequestAndASession() throws {
        let asksForCode = Data(#"{"verificationRequired":true,"email":"gate@example.com"}"#.utf8)
        guard case .verificationRequired = try JSONDecoder().decode(LiveGateSignUpAnswer.self, from: asksForCode) else {
            return XCTFail("expected a code request")
        }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        let issued = Data(#"{"accessToken":"access","refreshToken":"refresh","expiresAt":"2026-09-03T00:00:00Z","user":{"id":"11111111-1111-4111-8111-111111111111","email":"gate@example.com"}}"#.utf8)
        guard case let .session(session) = try decoder.decode(LiveGateSignUpAnswer.self, from: issued) else {
            return XCTFail("expected a session")
        }
        XCTAssertEqual(session.accessToken, "access")
    }
}
