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
/// Output is content-free: step names, booleans, counts, and error codes.
@MainActor
final class LiveGateTests: XCTestCase {
    private static let environment = ProcessInfo.processInfo.environment
    private static var enabled: Bool { environment["UNFILED_LIVE_GATE"] == "1" }
    private static var organizerKey: String? {
        let value = environment["UNFILED_LIVE_GATE_OPENAI_API_KEY"] ?? ""
        return value.isEmpty ? nil : value
    }

    private var model: AppModel!
    private var steps: [(name: String, ok: Bool, detail: String)] = []

    override func setUp() async throws {
        try XCTSkipUnless(Self.enabled, "live gate not requested")
        let defaults = UserDefaults(suiteName: "LiveGateTests.\(UUID().uuidString)")!
        model = AppModel(bundle: Bundle.main, userDefaults: defaults)
        try XCTSkipIf(model.apiHostLabel == "Unavailable", "no runtime: set UNFILED_LIVE_GATE_API_BASE_URL")
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
    private func signUpWaitingForRateLimit(email: String, password: String) async throws -> AuthSession {
        for attempt in 0 ..< 3 {
            do {
                return try await model.signUp(try AuthPasswordRequest(email: email, password: password))
            } catch let APIClientError.http(status, _, _, retryAfterSeconds) where status == 429 && attempt < 2 {
                let wait = min(retryAfterSeconds ?? 60, 360)
                print("wait  auth.sign_up rate limited; retrying in \(wait)s")
                try await Task.sleep(for: .seconds(wait + 1))
            }
        }
        return try await model.signUp(try AuthPasswordRequest(email: email, password: password))
    }

    func testLiveGate() async throws {
        let stamp = String(Int(Date().timeIntervalSince1970), radix: 36)
        let email = "gate-phone-\(stamp)@example.com"
        let password = "Gate-\(UUID().uuidString.prefix(20))-1"

        // Account
        let session = try await signUpWaitingForRateLimit(email: email, password: password)
        step("auth.sign_up", !session.accessToken.isEmpty)
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
