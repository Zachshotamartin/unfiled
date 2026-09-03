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

    let source: LocalCaptureSource
    let composerGeneration: Int
    let restoredDraft: Bool
    let onSave: @MainActor (String, LocalPrivacyMode, LocalCaptureSource, Int) async throws -> Void
    let onDraftChange: @MainActor (String, LocalPrivacyMode, LocalCaptureSource, Int) async throws -> Void
    let onDiscardDraft: @MainActor (LocalCaptureSource, Int) async throws -> Void

    init(
        source: LocalCaptureSource,
        composerGeneration: Int,
        initialContent: String = "",
        initialPrivacy: LocalPrivacyMode = .aiAssisted,
        restoredDraft: Bool = false,
        onSave: @escaping @MainActor (String, LocalPrivacyMode, LocalCaptureSource, Int) async throws -> Void,
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
        !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && content.utf16.count <= 10_000
            && !isSaving
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if restoredDraft {
                    Label("Unsaved draft", systemImage: "clock.arrow.circlepath")
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
                            Label("Organize for me", systemImage: "tray.and.arrow.down")
                                .tag(LocalPrivacyMode.aiAssisted)
                            Label("Private manual", systemImage: "lock")
                                .tag(LocalPrivacyMode.privateManual)
                        }
                    } label: {
                        HStack(spacing: 6) {
                            GlyphView(glyph: privacy == .privateManual ? .lock : .organize, size: 15, weight: 1.7)
                            Text(privacy == .privateManual ? "Private" : "Organize")
                                .font(UnfiledType.caption)
                        }
                        .foregroundStyle(UnfiledTheme.paper)
                        .padding(.horizontal, 14)
                        .frame(minHeight: 40)
                        .background(UnfiledTheme.raised)
                        .clipShape(Capsule())
                    }
                    .accessibilityLabel(
                        privacy == .privateManual ? "Private manual capture" : "AI-assisted capture"
                    )

                    Spacer()

                    Text("\(content.utf16.count)/10,000")
                        .font(UnfiledType.caption)
                        .foregroundStyle(content.utf16.count > 10_000 ? UnfiledTheme.persimmon : UnfiledTheme.fog)

                    Button {
                        guard canSave else { return }
                        isSaving = true
                        errorMessage = nil
                        Task { @MainActor in
                            do {
                                try await onSave(content, privacy, source, composerGeneration)
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
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { focused = false }
                        .font(UnfiledType.heading)
                        .foregroundStyle(UnfiledTheme.persimmon)
                        .accessibilityIdentifier("capture.keyboard-done")
                }
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
        .interactiveDismissDisabled(isSaving || !content.isEmpty)
        .unfiledScreen()
    }

    private var draftChangeIdentifier: String {
        "\(composerGeneration):\(isSaving):\(privacy.rawValue):\(content)"
    }

    private func close() {
        if content.isEmpty {
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
