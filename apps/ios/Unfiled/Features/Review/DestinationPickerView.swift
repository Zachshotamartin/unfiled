import SwiftUI

struct DestinationPickerView: View {
    let sheet: DestinationPickerSheet
    let notes: [NotePresentation]
    let spaces: [SpacePresentation]
    let isSubmitting: Bool
    let errorMessage: String?
    let onCancel: @MainActor () -> Void
    let onSubmit: @MainActor (DestinationChoice) async -> Void

    @State private var mode: DestinationPickerMode
    @State private var selectedNoteID: String?
    @State private var title: String
    @State private var noteType: NoteType
    @State private var spaceID: String?
    @FocusState private var titleFocused: Bool

    init(
        sheet: DestinationPickerSheet,
        notes: [NotePresentation],
        spaces: [SpacePresentation],
        isSubmitting: Bool,
        errorMessage: String?,
        onCancel: @escaping @MainActor () -> Void,
        onSubmit: @escaping @MainActor (DestinationChoice) async -> Void
    ) {
        self.sheet = sheet
        self.notes = notes
        self.spaces = spaces
        self.isSubmitting = isSubmitting
        self.errorMessage = errorMessage
        self.onCancel = onCancel
        self.onSubmit = onSubmit
        _mode = State(initialValue: sheet.initialMode)
        _title = State(initialValue: sheet.suggestedTitle)
        _noteType = State(initialValue: sheet.suggestedType)
        _spaceID = State(initialValue: sheet.suggestedSpaceID)
        _selectedNoteID = State(
            initialValue: Self.initialSelectionID(notes: notes, purpose: sheet.purpose)
        )
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    EditorialEyebrow(text: eyebrow)

                    Text(screenTitle)
                        .font(UnfiledType.display)
                        .tracking(-0.9)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityAddTraits(.isHeader)
                        .padding(.top, UnfiledTheme.eyebrowToTitle)

                    Text(explanation)
                        .font(UnfiledType.body)
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)

                    choiceRow(label: "Destination", identifier: "destination.mode.\(sheet.id)") {
                        ForEach(DestinationPickerMode.allCases) { value in
                            Chip(title: value.rawValue, selected: mode == value) {
                                choose { mode = value }
                            }
                        }
                    }
                    .accessibilityLabel("Destination, \(mode.rawValue)")
                    .padding(.top, UnfiledTheme.sectionTop)

                    SectionRule()
                        .padding(.top, UnfiledTheme.headerBottom)

                    if mode == .existing {
                        existingNotes
                    } else {
                        newNoteForm
                    }
                }
                .padding(.horizontal, UnfiledTheme.screenPadding)
                .padding(.top, UnfiledTheme.pushedHeaderTop)
                .padding(.bottom, UnfiledTheme.screenBottom)
            }
            .scrollDismissesKeyboard(.interactively)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                submitBar
            }
            .toolbar {
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { titleFocused = false }
                        .font(UnfiledType.heading)
                        .foregroundStyle(UnfiledTheme.persimmon)
                        .accessibilityIdentifier("destination.keyboard-done.\(sheet.id)")
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { onCancel() } label: {
                        GlyphView(glyph: .close, size: 18, weight: 1.9)
                            .foregroundStyle(UnfiledTheme.paper)
                            .frame(minWidth: 44, minHeight: 44)
                    }
                    .disabled(isSubmitting)
                    .accessibilityLabel("Cancel")
                    .accessibilityIdentifier("destination.cancel.\(sheet.id)")
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .unfiledScreen()
        }
        .onChange(of: mode) { _, newMode in
            if newMode == .newNote {
                titleFocused = true
            }
        }
        .interactiveDismissDisabled(isSubmitting)
    }

    private var existingNotes: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            EditorialEyebrow(text: "Available notes")
                .padding(.top, UnfiledTheme.rowVertical)
                .padding(.bottom, UnfiledTheme.labelToRule)

            if eligibleNotes.isEmpty {
                Text("There are no other active notes yet. Create a new note instead.")
                    .font(UnfiledType.body)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.vertical, UnfiledTheme.rowVertical)
            } else {
                ForEach(eligibleNotes) { note in
                    Button {
                        choose { selectedNoteID = note.id }
                    } label: {
                        HStack(alignment: .top, spacing: 14) {
                            selectionMark(selected: selectedNoteID == note.id)

                            VStack(alignment: .leading, spacing: 5) {
                                Text(note.title)
                                    .font(UnfiledType.heading)
                                    .foregroundStyle(UnfiledTheme.paper)
                                    .fixedSize(horizontal: false, vertical: true)
                                Text("\(note.type.capitalized) · \(note.updatedLabel)")
                                    .font(UnfiledType.caption)
                                    .foregroundStyle(UnfiledTheme.fog)
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                            Spacer(minLength: 8)
                        }
                        .frame(maxWidth: .infinity, minHeight: 58, alignment: .leading)
                        .contentShape(Rectangle())
                        .padding(.vertical, 8)
                    }
                    .buttonStyle(.unfiledPress)
                    .disabled(isSubmitting)
                    .accessibilityLabel(note.title)
                    .accessibilityValue(selectedNoteID == note.id ? "Selected" : "Not selected")
                    .accessibilityHint("Selects this note as the destination")
                    .accessibilityIdentifier("destination.note.\(note.id)")
                    SectionRule()
                }
            }
        }
    }

    /// The selection mark is the app's own check on a card-sized ring, never a system symbol.
    private func selectionMark(selected: Bool) -> some View {
        ZStack {
            Circle()
                .stroke(selected ? UnfiledTheme.persimmon : UnfiledTheme.border, lineWidth: 1.5)
            if selected {
                GlyphView(glyph: .check, size: 14, weight: 2)
                    .foregroundStyle(UnfiledTheme.persimmon)
            }
        }
        .frame(width: 24, height: 24)
        .padding(.top, 2)
        .accessibilityHidden(true)
    }

    private var newNoteForm: some View {
        VStack(alignment: .leading, spacing: 22) {
            VStack(alignment: .leading, spacing: 10) {
                EditorialEyebrow(text: "Note title")
                TextField("New note title", text: $title)
                    .textInputAutocapitalization(.sentences)
                    .submitLabel(.done)
                    .focused($titleFocused)
                    .font(UnfiledType.body)
                    .padding(.horizontal, UnfiledTheme.fieldPadding)
                    .frame(minHeight: UnfiledTheme.controlHeight)
                    .background(UnfiledTheme.graphite)
                    .overlay {
                        RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                            .stroke(
                                titleFocused ? UnfiledTheme.persimmon : UnfiledTheme.border,
                                lineWidth: titleFocused ? 2 : 1
                            )
                    }
                    .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                    .accessibilityIdentifier("destination.title.\(sheet.id)")
            }

            choiceRow(label: "Note type", identifier: "destination.noteType.\(sheet.id)") {
                ForEach(NoteType.allCases, id: \.rawValue) { value in
                    Chip(title: value.rawValue.capitalized, selected: noteType == value) {
                        choose { noteType = value }
                    }
                }
            }
            .accessibilityLabel("Note type, \(noteType.rawValue)")

            choiceRow(label: "Space", identifier: "destination.space.\(sheet.id)") {
                Chip(title: "None", selected: spaceID == nil) {
                    choose { spaceID = nil }
                }
                ForEach(spaces) { space in
                    Chip(title: space.name, selected: spaceID == space.id) {
                        choose { spaceID = space.id }
                    }
                }
            }
            .accessibilityLabel("Space, \(selectedSpaceName)")
        }
        .padding(.top, 20)
    }

    private var submitBar: some View {
        VStack(spacing: 0) {
            SectionRule()
            if let errorMessage {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    GlyphView(glyph: .warning, size: 16, weight: 2)
                        .foregroundStyle(UnfiledTheme.paper)
                        .accessibilityHidden(true)
                    Text(errorMessage)
                        .font(UnfiledType.secondary)
                        .foregroundStyle(UnfiledTheme.paper)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, UnfiledTheme.screenPadding)
                .padding(.top, 14)
                .accessibilityIdentifier("destination.error.\(sheet.id)")
            }
            Button {
                Task { @MainActor in
                    await onSubmit(choice)
                }
            } label: {
                HStack(spacing: 9) {
                    if isSubmitting {
                        UnfiledLoadingView(size: 18, label: "Saving")
                    }
                    Text(isSubmitting ? "Saving choice…" : submitTitle)
                        .font(UnfiledType.heading)
                    if !isSubmitting {
                        GlyphView(glyph: .chevron, size: 16, weight: 2)
                            .accessibilityHidden(true)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
                .foregroundStyle(UnfiledTheme.ink)
                .background(canSubmit ? UnfiledTheme.persimmon : UnfiledTheme.fog)
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            }
            .buttonStyle(.unfiledPress)
            .disabled(!canSubmit)
            .accessibilityIdentifier("destination.submit.\(sheet.id)")
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.top, 14)
            .padding(.bottom, 10)
        }
        .background(UnfiledTheme.ink)
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
            // Wrapping rather than scrolling sideways: a note type or a space the owner cannot
            // see is one they do not know they can choose.
            FlowLayout {
                content()
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(identifier)
    }

    private var selectedSpaceName: String {
        spaces.first { $0.id == spaceID }?.name ?? "None"
    }

    private var eligibleNotes: [NotePresentation] {
        Self.eligibleNotes(notes: notes, purpose: sheet.purpose)
    }

    static func initialSelectionID(
        notes: [NotePresentation],
        purpose: DestinationPickerPurpose
    ) -> String? {
        eligibleNotes(notes: notes, purpose: purpose).first?.id
    }

    private static func eligibleNotes(
        notes: [NotePresentation],
        purpose: DestinationPickerPurpose
    ) -> [NotePresentation] {
        let sourceID = sourceNoteID(for: purpose)
        return notes.filter { $0.id != sourceID && $0.isOpen && !$0.archived && !$0.deleted }
    }

    private var normalizedTitle: String {
        title.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var canSubmit: Bool {
        guard !isSubmitting else { return false }
        switch mode {
        case .existing:
            return eligibleNotes.contains { $0.id == selectedNoteID }
        case .newNote: return (1 ... 200).contains(normalizedTitle.utf16.count)
        }
    }

    private var choice: DestinationChoice {
        switch mode {
        case .existing:
            return .existing(noteID: selectedNoteID ?? "")
        case .newNote:
            return .newNote(
                title: normalizedTitle,
                noteType: noteType,
                spaceID: spaceID
            )
        }
    }

    private var eyebrow: String {
        switch sheet.purpose {
        case .correction: "Correction"
        case .review: "Review choice"
        }
    }

    private var screenTitle: String {
        switch sheet.purpose {
        case .correction: "Move this capture"
        case .review: "Choose where it belongs"
        }
    }

    private var explanation: String {
        switch sheet.purpose {
        case .correction:
            "Unfiled will remove only the exact filed change, then add it to your choice. If that is no longer safe, nothing moves and the capture goes to Review."
        case .review:
            "Choose an existing note or make a new one. The original capture stays available in either case."
        }
    }

    private var submitTitle: String {
        switch sheet.purpose {
        case .correction: "Move capture"
        case .review: "File capture"
        }
    }

    private static func sourceNoteID(for purpose: DestinationPickerPurpose) -> String? {
        guard case let .correction(_, _, sourceNoteID) = purpose else { return nil }
        return sourceNoteID
    }
}
