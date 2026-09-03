import PhotosUI
import SwiftUI

struct CaptureComposerView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var scenePhase
    @FocusState private var focused: Bool
    @State private var content: String
    @State private var privacy: LocalPrivacyMode
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var confirmsClose = false
    @State private var attachments: [PendingCaptureAttachment] = []
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showsPhotoPicker = false
    @State private var showsCamera = false
    @State private var attachmentNotice: String?
    @State private var idGenerator = PrefixedULIDGenerator()
    // Speaking a capture is the keyboard's dictation key; the app adds nothing to it.

    let source: LocalCaptureSource
    let composerGeneration: Int
    let restoredDraft: Bool
    let onSave: @MainActor (String, LocalPrivacyMode, LocalCaptureSource, Int, [CaptureAttachmentDraft]) async throws -> Void
    let onDraftChange: @MainActor (String, LocalPrivacyMode, LocalCaptureSource, Int) async throws -> Void
    let onDiscardDraft: @MainActor (LocalCaptureSource, Int) async throws -> Void

    init(
        source: LocalCaptureSource,
        composerGeneration: Int,
        initialContent: String = "",
        initialPrivacy: LocalPrivacyMode = .aiAssisted,
        restoredDraft: Bool = false,
        onSave: @escaping @MainActor (String, LocalPrivacyMode, LocalCaptureSource, Int, [CaptureAttachmentDraft]) async throws -> Void,
        onDraftChange: @escaping @MainActor (String, LocalPrivacyMode, LocalCaptureSource, Int) async throws -> Void,
        onDiscardDraft: @escaping @MainActor (LocalCaptureSource, Int) async throws -> Void
    ) {
        self.source = source
        self.composerGeneration = composerGeneration
        self.restoredDraft = restoredDraft
        self.onSave = onSave
        self.onDraftChange = onDraftChange
        self.onDiscardDraft = onDiscardDraft
        _content = State(initialValue: initialContent)
        _privacy = State(initialValue: initialPrivacy)
    }

    private var canSave: Bool {
        CaptureComposerRules.canSend(content: content, attachmentCount: attachments.count) && !isSaving
    }

    private var attachmentKinds: [LocalAttachmentKind] { attachments.map(\.kind) }
    private var remainingPhotos: Int { CaptureComposerRules.remainingPhotos(given: attachmentKinds) }
    private var isEmpty: Bool { content.isEmpty && attachments.isEmpty }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if restoredDraft {
                    GlyphLabel("Unsaved draft", glyph: .clock)
                        .font(UnfiledType.caption)
                        .foregroundStyle(UnfiledTheme.fog)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, UnfiledTheme.screenPadding)
                        .padding(.top, 8)
                        .accessibilityIdentifier("capture.restored-draft")
                }

                TextEditor(text: $content)
                    .font(UnfiledType.composer)
                    .lineSpacing(6)
                    .scrollDismissesKeyboard(.interactively)
                    .scrollContentBackground(.hidden)
                    .foregroundStyle(UnfiledTheme.paper)
                    .focused($focused)
                    .padding(.horizontal, UnfiledTheme.screenPadding - 5)
                    .padding(.top, 22)
                    .overlay(alignment: .topLeading) {
                        if content.isEmpty {
                            Text("What's on your mind?")
                                .font(UnfiledType.composer)
                                .foregroundStyle(UnfiledTheme.fog)
                                .padding(.horizontal, UnfiledTheme.screenPadding)
                                .padding(.top, 30)
                                .allowsHitTesting(false)
                                .accessibilityHidden(true)
                        }
                    }
                    .accessibilityLabel("Capture text")

                if !attachments.isEmpty {
                    CaptureAttachmentStrip(attachments: attachments) { id in
                        attachments.removeAll { $0.id == id }
                    }
                }

                if let attachmentNotice {
                    Text(attachmentNotice)
                        .font(UnfiledType.caption)
                        .foregroundStyle(UnfiledTheme.fog)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, UnfiledTheme.screenPadding)
                        .padding(.bottom, 6)
                        .accessibilityIdentifier("capture.attachment-notice")
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(UnfiledType.caption)
                        .foregroundStyle(UnfiledTheme.persimmon)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, UnfiledTheme.screenPadding)
                        .padding(.bottom, 10)
                }

                SectionRule()

                HStack(spacing: UnfiledTheme.controlGap) {
                    Menu {
                        Picker("Privacy", selection: $privacy) {
                            Label { Text("Organize for me") } icon: { GlyphImage.image(.organize) }
                                .tag(LocalPrivacyMode.aiAssisted)
                            Label { Text("Private manual") } icon: { GlyphImage.image(.lock) }
                                .tag(LocalPrivacyMode.privateManual)
                        }
                    } label: {
                        // Organizing is the default and needs no word; only the private mode
                        // names itself, which keeps the row from crowding on a narrow phone.
                        HStack(spacing: 6) {
                            GlyphView(glyph: privacy == .privateManual ? .lock : .organize, size: 18, weight: 1.9)
                            if privacy == .privateManual {
                                Text("Private")
                                    .font(UnfiledType.caption)
                                    .fixedSize()
                            }
                        }
                        .foregroundStyle(UnfiledTheme.paper)
                        .padding(.horizontal, privacy == .privateManual ? 14 : 12)
                        .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                        .background(UnfiledTheme.raised)
                        .clipShape(Capsule())
                    }
                    .fixedSize()
                    .accessibilityLabel(
                        privacy == .privateManual ? "Private manual capture" : "AI-assisted capture"
                    )

                    // One control for photos: the library, or the camera when there is one.
                    Menu {
                        Button {
                            addPhotoTapped { showsPhotoPicker = true }
                        } label: {
                            Label { Text("Choose photo") } icon: { GlyphImage.image(.photo) }
                        }
                        if CameraCaptureView.isAvailable {
                            Button {
                                addPhotoTapped { showsCamera = true }
                            } label: {
                                Label { Text("Take photo") } icon: { GlyphImage.image(.camera) }
                            }
                        }
                    } label: {
                        GlyphView(glyph: .photo, size: 20, weight: 1.9)
                            .foregroundStyle(UnfiledTheme.paper)
                            .frame(
                                width: UnfiledTheme.minimumTouchTarget,
                                height: UnfiledTheme.minimumTouchTarget
                            )
                            .background(UnfiledTheme.raised)
                            .clipShape(Circle())
                    }
                    .accessibilityLabel("Add photo")
                    .accessibilityIdentifier("capture.add-photo")

                    Spacer(minLength: 4)

                    // The count matters only as the limit comes into view; until then it is noise.
                    if content.utf16.count >= 9_000 {
                        Text("\(content.utf16.count)/10,000")
                            .font(UnfiledType.caption)
                            .monospacedDigit()
                            .fixedSize()
                            .foregroundStyle(
                                content.utf16.count > 10_000 ? UnfiledTheme.persimmon : UnfiledTheme.fog
                            )
                    }

                    Button {
                        guard canSave else { return }
                        isSaving = true
                        errorMessage = nil
                        Task { @MainActor in
                            do {
                                try await onSave(
                                    CaptureComposerRules.rawContent(content: content, kinds: attachmentKinds),
                                    privacy,
                                    source,
                                    composerGeneration,
                                    attachments.map(\.draft)
                                )
                                UnfiledHaptics.saved()
                                dismiss()
                            } catch {
                                errorMessage = "That capture was not saved. Try again."
                                isSaving = false
                            }
                        }
                    } label: {
                        Group {
                            if isSaving {
                                ProgressView()
                                    .tint(UnfiledTheme.ink)
                            } else {
                                GlyphView(glyph: .send, size: 22, weight: 2.2)
                            }
                        }
                        .foregroundStyle(UnfiledTheme.ink)
                        .frame(width: 54, height: 54)
                        .background(canSave ? UnfiledTheme.persimmon : UnfiledTheme.fog.opacity(0.35))
                        .clipShape(Circle())
                    }
                    .buttonStyle(UnfiledPressStyle(scale: 0.9))
                    .disabled(!canSave)
                    .accessibilityLabel("Save capture")
                }
                .padding(.horizontal, UnfiledTheme.screenPadding)
                .padding(.vertical, 14)
            }
            .background(UnfiledTheme.ink)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { close() } label: {
                        GlyphView(glyph: .close, size: 18, weight: 1.9)
                            .foregroundStyle(UnfiledTheme.paper)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .accessibilityLabel("Close")
                }
            }
            .onAppear { focused = true }
            .photosPicker(
                isPresented: $showsPhotoPicker,
                selection: $pickerItems,
                maxSelectionCount: max(remainingPhotos, 1),
                matching: .images,
                preferredItemEncoding: .compatible
            )
            .onChange(of: pickerItems) { _, items in
                guard !items.isEmpty else { return }
                pickerItems = []
                Task { @MainActor in await addPickedPhotos(items) }
            }
            .fullScreenCover(isPresented: $showsCamera) {
                CameraCaptureView { data in
                    Task { @MainActor in await addPhoto(data: data) }
                }
                .ignoresSafeArea()
            }
            .task(id: draftChangeIdentifier) {
                guard !isSaving else { return }
                do {
                    try await Task.sleep(for: .milliseconds(250))
                    try Task.checkCancellation()
                    guard !isSaving else { return }
                    try await onDraftChange(content, privacy, source, composerGeneration)
                } catch is CancellationError {
                    return
                } catch {
                    errorMessage = "This draft could not be protected on this device."
                }
            }
            .onChange(of: scenePhase) { _, newPhase in
                guard newPhase != .active, !isSaving else { return }
                Task { @MainActor in
                    try? await onDraftChange(content, privacy, source, composerGeneration)
                }
            }
        }
        .confirmationDialog(
            "Keep this draft?",
            isPresented: $confirmsClose,
            titleVisibility: .visible
        ) {
            Button("Keep draft") { dismiss() }
            Button("Discard draft", role: .destructive) {
                isSaving = true
                Task { @MainActor in
                    do {
                        try await onDiscardDraft(source, composerGeneration)
                        dismiss()
                    } catch {
                        errorMessage = "This draft could not be discarded."
                        isSaving = false
                    }
                }
            }
            Button("Keep writing", role: .cancel) {}
        } message: {
            Text("Unfiled can restore a kept draft the next time you open this capture.")
        }
        .interactiveDismissDisabled(isSaving || !isEmpty)
        .unfiledScreen()
    }

    private var draftChangeIdentifier: String {
        "\(composerGeneration):\(isSaving):\(privacy.rawValue):\(content)"
    }

    /// Downsizes and strips each picked photo before it can go anywhere.
    private func addPickedPhotos(_ items: [PhotosPickerItem]) async {
        for item in items {
            do {
                guard let data = try await item.loadTransferable(type: Data.self) else {
                    attachmentNotice = "That photo could not be read."
                    continue
                }
                await addPhoto(data: data)
            } catch {
                attachmentNotice = "That photo could not be read."
            }
        }
    }

    /// Opens one of the photo sources, or says why it cannot.
    private func addPhotoTapped(_ open: () -> Void) {
        guard remainingPhotos > 0 else {
            attachmentNotice = "Four photos is the most one capture can carry."
            return
        }
        attachmentNotice = nil
        open()
    }

    private func addPhoto(data: Data) async {
        guard CaptureComposerRules.canAdd(.image, to: attachmentKinds) else {
            attachmentNotice = "Four photos is the most one capture can carry."
            return
        }
        do {
            let prepared = try CaptureImagePreparation.prepare(imageData: data)
            let id = try await idGenerator.next(.attachment)
            attachments.append(PendingCaptureAttachment(
                id: id, kind: .image, mediaType: prepared.mediaType, bytes: prepared.data,
                width: prepared.width, height: prepared.height, durationMs: nil
            ))
            attachmentNotice = nil
        } catch {
            attachmentNotice = "That photo could not be read."
        }
    }

    private func close() {
        if isEmpty {
            isSaving = true
            Task { @MainActor in
                try? await onDiscardDraft(source, composerGeneration)
                dismiss()
            }
        } else {
            confirmsClose = true
        }
    }
}
