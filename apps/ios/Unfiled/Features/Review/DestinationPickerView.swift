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

                    Picker("Destination type", selection: $mode) {
                        ForEach(DestinationPickerMode.allCases) { value in
                            Text(value.rawValue).tag(value)
                        }
                    }
                    .pickerStyle(.segmented)
                    .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                    .padding(.top, UnfiledTheme.sectionTop)
                    .accessibilityIdentifier("destination.mode.\(sheet.id)")

                    SectionRule()
                        .padding(.top, UnfiledTheme.headerBottom)

                    if mode == .existing {
                        existingNotes
                    } else {
                        newNoteForm
                    }

                    if let errorMessage {
                        Label(errorMessage, systemImage: "exclamationmark.circle")
                            .font(UnfiledType.secondary)
                            .foregroundStyle(UnfiledTheme.paper)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 20)
                            .accessibilityIdentifier("destination.error.\(sheet.id)")
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
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                        .disabled(isSubmitting)
                        .frame(minWidth: UnfiledTheme.minimumTouchTarget,
                               minHeight: UnfiledTheme.minimumTouchTarget)
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
                        selectedNoteID = note.id
                    } label: {
                        HStack(alignment: .top, spacing: 14) {
                            Image(systemName: selectedNoteID == note.id ? "checkmark.circle.fill" : "circle")
                                .font(UnfiledType.title)
                                .foregroundStyle(
                                    selectedNoteID == note.id
                                        ? UnfiledTheme.persimmon
                                        : UnfiledTheme.fog
                                )
                                .accessibilityHidden(true)

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
                    .buttonStyle(.plain)
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

            VStack(alignment: .leading, spacing: 10) {
                EditorialEyebrow(text: "Note type")
                Picker("Note type", selection: $noteType) {
                    ForEach(NoteType.allCases, id: \.rawValue) { value in
                        Text(value.rawValue.capitalized).tag(value)
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight, alignment: .leading)
                .padding(.horizontal, UnfiledTheme.fieldPadding)
                .background(UnfiledTheme.graphite)
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                .accessibilityIdentifier("destination.noteType.\(sheet.id)")
            }

            VStack(alignment: .leading, spacing: 10) {
                EditorialEyebrow(text: "Space")
                Picker("Space", selection: $spaceID) {
                    Text("Unfiled").tag(String?.none)
                    ForEach(spaces) { space in
                        Text(space.name).tag(String?.some(space.id))
                    }
                }
                .pickerStyle(.menu)
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight, alignment: .leading)
                .padding(.horizontal, UnfiledTheme.fieldPadding)
                .background(UnfiledTheme.graphite)
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                .accessibilityIdentifier("destination.space.\(sheet.id)")
            }
        }
        .padding(.top, 20)
    }

    private var submitBar: some View {
        VStack(spacing: 0) {
            SectionRule()
            Button {
                Task { @MainActor in
                    await onSubmit(choice)
                }
            } label: {
                HStack(spacing: 9) {
                    if isSubmitting {
                        ProgressView()
                            .controlSize(.small)
                            .tint(UnfiledTheme.ink)
                            .accessibilityHidden(true)
                    }
                    Text(isSubmitting ? "Saving choice…" : submitTitle)
                        .font(UnfiledType.heading)
                    if !isSubmitting {
                        Image(systemName: "arrow.right")
                            .font(UnfiledType.label)
                            .accessibilityHidden(true)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
                .foregroundStyle(UnfiledTheme.ink)
                .background(canSubmit ? UnfiledTheme.persimmon : UnfiledTheme.fog)
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            }
            .buttonStyle(.plain)
            .disabled(!canSubmit)
            .accessibilityIdentifier("destination.submit.\(sheet.id)")
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.top, 14)
            .padding(.bottom, 10)
        }
        .background(UnfiledTheme.ink)
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
