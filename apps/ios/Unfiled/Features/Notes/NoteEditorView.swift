import SwiftUI

struct NoteEditorDraft: Equatable, Sendable {
    static let maximumTitleLength = 200
    static let maximumBodyLength = 200_000

    var noteID: String?
    var title: String
    var bodyMarkdown: String
    var type: NoteType
    var privacy: PrivacyMode
    var spaceID: String?

    var normalizedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var validationIssue: String? {
        if normalizedTitle.isEmpty { return "Add a title before saving." }
        if title.utf16.count > Self.maximumTitleLength {
            return "The title must be 200 characters or fewer."
        }
        if bodyMarkdown.utf16.count > Self.maximumBodyLength {
            return "The note must be 200,000 characters or fewer."
        }
        return nil
    }

    var normalizedForSave: NoteEditorDraft {
        var copy = self
        copy.title = normalizedTitle
        return copy
    }
}

struct NoteEditorView: View {
    private enum FocusedField: Hashable {
        case title
        case body
    }

    @FocusState private var focusedField: FocusedField?
    @State private var draft: NoteEditorDraft
    @State private var savedDraft: NoteEditorDraft
    @State private var isSaving = false
    @State private var errorMessage: String?
    @State private var confirmsDiscard = false

    let spaces: [SpacePresentation]
    let currentRevision: Int?
    let onCancel: @MainActor () -> Void
    let onSave: @MainActor (NoteEditorDraft) async throws -> Void

    init(
        draft: NoteEditorDraft,
        spaces: [SpacePresentation],
        currentRevision: Int?,
        onCancel: @escaping @MainActor () -> Void,
        onSave: @escaping @MainActor (NoteEditorDraft) async throws -> Void
    ) {
        _draft = State(initialValue: draft)
        _savedDraft = State(initialValue: draft)
        self.spaces = spaces
        self.currentRevision = currentRevision
        self.onCancel = onCancel
        self.onSave = onSave
    }

    private var isNewNote: Bool { draft.noteID == nil }
    private var isDirty: Bool { draft != savedDraft }
    private var canSave: Bool {
        isDirty && draft.validationIssue == nil && !isSaving
    }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if isNewNote || !spaces.isEmpty {
                        editorHeader
                    }
                    SectionRule()

                    VStack(alignment: .leading, spacing: 9) {
                        Text("Title")
                            .font(UnfiledType.label)
                            .foregroundStyle(UnfiledTheme.fog)

                        TextField("Untitled note", text: $draft.title, axis: .vertical)
                            .font(UnfiledType.display)
                            .tracking(-1)
                            .foregroundStyle(UnfiledTheme.paper)
                            .focused($focusedField, equals: .title)
                            .submitLabel(.next)
                            .onSubmit { focusedField = .body }
                            .accessibilityIdentifier("noteEditor.title")

                        Text("\(draft.title.utf16.count)/\(NoteEditorDraft.maximumTitleLength)")
                            .font(UnfiledType.caption)
                            .foregroundStyle(
                                draft.title.utf16.count > NoteEditorDraft.maximumTitleLength
                                    ? UnfiledTheme.persimmon : UnfiledTheme.fog
                            )
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    .padding(.vertical, UnfiledTheme.rowVertical)

                    SectionRule()

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Note")
                            .font(UnfiledType.label)
                            .foregroundStyle(UnfiledTheme.fog)

                        ZStack(alignment: .topLeading) {
                            if draft.bodyMarkdown.isEmpty {
                                Text("Start writing")
                                    .font(UnfiledType.body)
                                    .foregroundStyle(UnfiledTheme.fog.opacity(0.72))
                                    .padding(.top, 8)
                                    .accessibilityHidden(true)
                            }
                            TextEditor(text: $draft.bodyMarkdown)
                                .font(UnfiledType.body)
                                .lineSpacing(6)
                                .scrollContentBackground(.hidden)
                                .foregroundStyle(UnfiledTheme.paper)
                                .frame(minHeight: 340)
                                .focused($focusedField, equals: .body)
                                .accessibilityLabel("Note body")
                                .accessibilityIdentifier("noteEditor.body")
                        }

                        Text("\(draft.bodyMarkdown.utf16.count)/\(NoteEditorDraft.maximumBodyLength)")
                            .font(UnfiledType.caption)
                            .foregroundStyle(
                                draft.bodyMarkdown.utf16.count > NoteEditorDraft.maximumBodyLength
                                    ? UnfiledTheme.persimmon : UnfiledTheme.fog
                            )
                            .frame(maxWidth: .infinity, alignment: .trailing)
                    }
                    .padding(.vertical, UnfiledTheme.rowVertical)

                    if let message = draft.validationIssue ?? errorMessage {
                        Label { Text(message) } icon: { GlyphView(glyph: .warning, size: 16, weight: 2) }
                            .font(UnfiledType.secondaryStrong)
                            .foregroundStyle(UnfiledTheme.persimmon)
                            .padding(.bottom, 20)
                            .accessibilityIdentifier("noteEditor.error")
                    }
                }
                .padding(.horizontal, UnfiledTheme.screenPadding)
            }
            .scrollDismissesKeyboard(.interactively)

            markdownToolbar
        }
        .toolbar { navigationToolbar }
        .confirmationDialog(
            "Discard your changes?",
            isPresented: $confirmsDiscard,
            titleVisibility: .visible
        ) {
            Button("Discard changes", role: .destructive, action: onCancel)
            Button("Keep editing", role: .cancel) {}
        } message: {
            Text("This edit has not been saved.")
        }
        .interactiveDismissDisabled(isDirty || isSaving)
        .onAppear { focusedField = isNewNote ? .title : .body }
        .unfiledScreen()
    }

    private var editorHeader: some View {
        VStack(alignment: .leading, spacing: 16) {
            ViewThatFits(in: .horizontal) {
                HStack(spacing: UnfiledTheme.controlGap) { propertyControls }
                VStack(alignment: .leading, spacing: UnfiledTheme.controlGap) { propertyControls }
            }
        }
        .padding(.top, UnfiledTheme.pushedHeaderTop)
        .padding(.bottom, UnfiledTheme.headerBottom)
    }

    @ViewBuilder
    /// Three plain choices as three labeled chip rows. No menus: every option is visible and
    /// one tap away, and the selected chip is the only dark one.
    /// Three plain choices as three labeled chip rows. No menus: every option is visible and
    /// one tap away, and the selected chip is the only dark one.
    private var propertyControls: some View {
        VStack(alignment: .leading, spacing: UnfiledTheme.controlGap) {
            if isNewNote {
                choiceRow(label: "Kind", identifier: "noteEditor.type") {
                    ForEach(NoteType.allCases, id: \.self) { type in
                        Chip(title: type.rawValue.capitalized, selected: draft.type == type) {
                            choose { draft.type = type }
                        }
                    }
                }
                .accessibilityLabel("Note type, \(draft.type.rawValue)")
            }
            if !spaces.isEmpty {
                choiceRow(label: "Space", identifier: "noteEditor.space") {
                    Chip(title: "None", selected: draft.spaceID == nil) {
                        choose { draft.spaceID = nil }
                    }
                    ForEach(spaces) { space in
                        Chip(title: space.name, selected: draft.spaceID == space.id) {
                            choose { draft.spaceID = space.id }
                        }
                    }
                }
                .accessibilityLabel("Space, \(selectedSpaceName)")
            }
        }
    }

    private func choose(_ change: @escaping () -> Void) {
        UnfiledHaptics.selection()
        withAnimation(UnfiledMotion.animation(UnfiledMotion.quick)) { change() }
    }

    private func choiceRow<Content: View>(
        label: String,
        identifier: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            EditorialEyebrow(text: label)
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: UnfiledTheme.controlGap) {
                    content()
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private var selectedSpaceName: String {
        guard let spaceID = draft.spaceID,
              let space = spaces.first(where: { $0.id == spaceID })
        else { return "No space" }
        return space.name
    }

    private var markdownToolbar: some View {
        VStack(spacing: 0) {
            SectionRule()
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    markdownButton("Heading", glyph: .heading, insertion: "## ")
                    markdownButton("Bulleted list", glyph: .bullets, insertion: "- ")
                    markdownButton("Checklist", glyph: .checklist, insertion: "- [ ] ")
                    markdownButton("Quote", glyph: .quote, insertion: "> ")
                    markdownButton("Link", glyph: .link, insertion: "[label](https://)")
                }
                .padding(.horizontal, UnfiledTheme.screenPadding)
                .padding(.vertical, 8)
            }
        }
        .background(UnfiledTheme.graphite)
    }

    private func markdownButton(
        _ label: String,
        glyph: UnfiledGlyph,
        insertion: String
    ) -> some View {
        Button {
            appendMarkdown(insertion)
        } label: {
            GlyphView(glyph: glyph, size: 18, weight: 1.9)
                .foregroundStyle(UnfiledTheme.paper)
                .frame(width: 46, height: 44)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityIdentifier("noteEditor.format.\(label.replacingOccurrences(of: " ", with: "-"))")
    }

    @ToolbarContentBuilder
    private var navigationToolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button("Cancel") {
                if isDirty {
                    confirmsDiscard = true
                } else {
                    onCancel()
                }
            }
            .disabled(isSaving)
            .foregroundStyle(UnfiledTheme.paper)
            .accessibilityIdentifier("noteEditor.cancel")
        }

        ToolbarItem(placement: .topBarTrailing) {
            Button {
                save()
            } label: {
                if isSaving {
                    ProgressView().tint(UnfiledTheme.ink)
                } else {
                    Text("Save").fontWeight(.semibold)
                }
            }
            .frame(minWidth: 70, minHeight: 38)
            .foregroundStyle(UnfiledTheme.ink)
            .background(canSave ? UnfiledTheme.persimmon : UnfiledTheme.fog)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .buttonStyle(.plain)
            .disabled(!canSave)
            .accessibilityIdentifier("noteEditor.save")
        }
    }

    private func appendMarkdown(_ insertion: String) {
        let needsLineBreak = !draft.bodyMarkdown.isEmpty && !draft.bodyMarkdown.hasSuffix("\n")
        draft.bodyMarkdown += needsLineBreak ? "\n\(insertion)" : insertion
        focusedField = .body
    }

    private func save() {
        guard canSave else { return }
        isSaving = true
        errorMessage = nil
        focusedField = nil

        Task { @MainActor in
            do {
                let saved = draft.normalizedForSave
                try await onSave(saved)
                draft = saved
                savedDraft = saved
                isSaving = false
                UIAccessibility.post(notification: .announcement, argument: "Note saved")
            } catch {
                errorMessage = "Your note was not saved. Review the latest version and try again."
                isSaving = false
                UIAccessibility.post(notification: .announcement, argument: errorMessage)
            }
        }
    }
}
