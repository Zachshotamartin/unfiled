import SwiftUI

struct NotesLibraryView: View {
    @State private var query = ""
    @State private var filter: LibraryFilter = .all

    let notes: [NotePresentation]
    let spaces: [SpacePresentation]
    let isLoading: Bool
    let onRefresh: @MainActor () async -> Void
    let onOpenNote: @MainActor (String) -> Void
    let onCreateNote: @MainActor () -> Void
    let onOpenArchive: @MainActor () -> Void
    let onOpenDeleted: @MainActor () -> Void

    private var visibleNotes: [NotePresentation] {
        let normalized = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalized.isEmpty else { return notes }
        return notes.filter {
            $0.title.localizedCaseInsensitiveContains(normalized)
                || $0.preview.localizedCaseInsensitiveContains(normalized)
        }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header
                searchField
                Picker("Library", selection: $filter) {
                    ForEach(LibraryFilter.allCases) { value in
                        Text(value.rawValue).tag(value)
                    }
                }
                .pickerStyle(.segmented)
                .padding(.vertical, 20)

                SectionRule()

                if filter == .all {
                    notesLedger
                } else {
                    spacesLedger
                }
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, 110)
        }
        .refreshable { await onRefresh() }
        .unfiledScreen()
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                UnfiledMark(size: 32)
                Spacer()
                Menu {
                    Button("New note", systemImage: "square.and.pencil", action: onCreateNote)
                    Button("Archive", systemImage: "archivebox", action: onOpenArchive)
                    Button("Recently deleted", systemImage: "trash", action: onOpenDeleted)
                } label: {
                    Image(systemName: "ellipsis.circle")
                        .font(.system(size: 24))
                        .foregroundStyle(UnfiledTheme.fog)
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Library actions")
            }
            Text("Notes")
                .font(.system(size: 52, weight: .bold))
                .tracking(-2)
        }
        .padding(.top, 12)
    }

    private var searchField: some View {
        HStack(spacing: 12) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(UnfiledTheme.fog)
            TextField("Filter notes", text: $query)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .foregroundStyle(UnfiledTheme.paper)
            if !query.isEmpty {
                Button("Clear", systemImage: "xmark.circle.fill") { query = "" }
                    .labelStyle(.iconOnly)
                    .foregroundStyle(UnfiledTheme.fog)
            }
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 52)
        .background(UnfiledTheme.graphite)
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .padding(.top, 26)
    }

    @ViewBuilder
    private var notesLedger: some View {
        if visibleNotes.isEmpty && !isLoading {
            EmptyLedgerView(
                title: query.isEmpty ? "No notes yet" : "No match",
                message: query.isEmpty
                    ? "Create one manually or capture a thought and let it find its place."
                    : "Try a different title or phrase.",
                actionTitle: query.isEmpty ? "New note" : nil,
                action: query.isEmpty ? onCreateNote : nil
            )
        } else {
            ForEach(visibleNotes) { note in
                Button { onOpenNote(note.id) } label: {
                    NoteLedgerRow(note: note)
                }
                .buttonStyle(.plain)
                SectionRule()
            }
        }
    }

    @ViewBuilder
    private var spacesLedger: some View {
        if spaces.isEmpty && !isLoading {
            EmptyLedgerView(
                title: "No spaces yet",
                message: "Spaces appear as your library develops. Notes are always available in All."
            )
        } else {
            ForEach(spaces) { space in
                HStack {
                    VStack(alignment: .leading, spacing: 5) {
                        Text(space.name)
                            .font(.system(size: 21, weight: .semibold))
                        Text("\(space.noteCount) notes")
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(UnfiledTheme.fog)
                    }
                    Spacer()
                    Image(systemName: "arrow.right")
                        .foregroundStyle(UnfiledTheme.persimmon)
                }
                .frame(minHeight: 82)
                SectionRule()
            }
        }
    }
}

private struct NoteLedgerRow: View {
    let note: NotePresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text(note.title)
                    .font(.system(size: 23, weight: .semibold))
                    .lineLimit(1)
                Spacer()
                Text(note.updatedLabel)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(UnfiledTheme.fog)
            }
            HStack(alignment: .bottom) {
                Text(note.preview)
                    .font(.system(size: 15))
                    .foregroundStyle(UnfiledTheme.fog)
                    .lineLimit(2)
                Spacer(minLength: 16)
                Image(systemName: note.type == "list" ? "list.bullet" : "note.text")
                    .foregroundStyle(UnfiledTheme.fog)
                Image(systemName: "arrow.right")
                    .foregroundStyle(UnfiledTheme.persimmon)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 104, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
