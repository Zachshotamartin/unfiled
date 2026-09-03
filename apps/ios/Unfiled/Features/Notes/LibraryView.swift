import SwiftUI

/// The Library: where filed things live. One search entry, spaces as cards, then notes grouped
/// by when they last changed. Cards are for browsing into; rows are for reading.
struct LibraryView<Search: View>: View {
    let notes: [NotePresentation]
    let spaces: [SpacePresentation]
    let isLoading: Bool
    let onRefresh: @MainActor () async -> Void
    let onOpenNote: @MainActor (String) -> Void
    let onOpenSpace: @MainActor (String?) -> Void
    let onOpenArchive: @MainActor () -> Void
    let onOpenDeleted: @MainActor () -> Void
    /// Builds the search results in place, driven by the Library's own field.
    @ViewBuilder let searchView: (_ query: Binding<String>) -> Search

    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private var isSearching: Bool { searchFocused || !query.isEmpty }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.bottom, UnfiledTheme.sectionTop)
                searchField
                if isSearching {
                    searchView($query)
                        .padding(.top, UnfiledTheme.controlGap)
                        .transition(UnfiledMotion.rise)
                } else {
                    libraryContent
                        .transition(.opacity)
                }
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, UnfiledTheme.screenBottom)
            .animation(UnfiledMotion.animation(UnfiledMotion.settle), value: isSearching)
        }
        .scrollDismissesKeyboard(.interactively)
        .refreshable { await onRefresh() }
        .unfiledScreen()
    }

    @ViewBuilder
    private var libraryContent: some View {
                if !spaceCards.isEmpty {
                    EditorialEyebrow(text: "Spaces")
                        .padding(.top, UnfiledTheme.sectionTop)
                        .padding(.bottom, UnfiledTheme.labelToRule)
                    LazyVGrid(columns: gridColumns, spacing: UnfiledTheme.controlGap) {
                        ForEach(spaceCards) { space in
                            SpaceCard(space: space) {
                                onOpenSpace(space.id)
                            }
                        }
                    }
                }
                if notes.isEmpty && !isLoading {
                    EmptyLedgerView(
                        title: "Nothing filed yet",
                        message: "Write something in the Inbox. Organized thoughts land here; private ones are kept as written."
                    )
                    .padding(.top, UnfiledTheme.sectionTop - UnfiledTheme.rowVertical)
                } else {
                    ForEach(NoteLibraryGrouping.groups(for: notes)) { group in
                        EditorialEyebrow(text: group.title)
                            .padding(.top, UnfiledTheme.sectionTop)
                            .padding(.bottom, UnfiledTheme.labelToRule)
                        SectionRule()
                        ForEach(group.notes) { note in
                            Button { onOpenNote(note.id) } label: {
                                NoteLibraryRow(note: note, spaceName: spaceName(for: note))
                            }
                            .buttonStyle(.unfiledPress)
                            .accessibilityIdentifier("notes.row.\(note.id)")
                            SectionRule()
                        }
                    }
                }
    }

    private var header: some View {
        ScreenHeader(title: "Library", subtitle: librarySummary) {
            Menu {
                Button(action: onOpenArchive) {
                    Label { Text("Archive") } icon: { GlyphImage.image(.archive) }
                }
                Button(action: onOpenDeleted) {
                    Label { Text("Recently deleted") } icon: { GlyphImage.image(.trash) }
                }
            } label: {
                GlyphView(glyph: .more, size: 20)
                    .foregroundStyle(UnfiledTheme.paper)
                    .frame(width: UnfiledTheme.minimumTouchTarget, height: UnfiledTheme.minimumTouchTarget)
                    .background(UnfiledTheme.graphite)
                    .clipShape(Circle())
            }
            .accessibilityLabel("Library actions")
        }
    }

    /// The one search field: typing here brings results in below it; clearing brings the
    /// Library back.
    private var searchField: some View {
        HStack(spacing: UnfiledTheme.controlGap) {
            GlyphView(glyph: .search, size: 18, weight: 1.8)
                .foregroundStyle(UnfiledTheme.fog)
            TextField("Search your notes", text: $query)
                .font(UnfiledType.body)
                .foregroundStyle(UnfiledTheme.paper)
                .focused($searchFocused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .onChange(of: query) { _, value in
                    query = SearchInputRules.bounded(value)
                }
                .accessibilityLabel("Search your notes")
                .accessibilityIdentifier("library.search-entry")
            if isSearching {
                Button {
                    UnfiledHaptics.tap()
                    query = ""
                    searchFocused = false
                } label: {
                    GlyphView(glyph: .close, size: 16, weight: 1.8)
                        .foregroundStyle(UnfiledTheme.fog)
                        .frame(width: UnfiledTheme.minimumTouchTarget, height: UnfiledTheme.minimumTouchTarget)
                }
                .buttonStyle(.unfiledPress)
                .accessibilityLabel("Leave search")
                .accessibilityIdentifier("library.search-leave")
            }
        }
        .padding(.leading, UnfiledTheme.fieldPadding)
        .padding(.trailing, isSearching ? 4 : UnfiledTheme.fieldPadding)
        .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight, alignment: .leading)
        .background(UnfiledTheme.graphite)
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .overlay {
            RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                .stroke(searchFocused ? UnfiledTheme.persimmon : UnfiledTheme.border, lineWidth: searchFocused ? 2 : 1)
        }
        .animation(UnfiledMotion.animation(UnfiledMotion.quick), value: searchFocused)
    }

    private var librarySummary: String {
        guard !notes.isEmpty else { return "Nothing filed yet." }
        let noteCount = notes.count == 1 ? "1 note" : "\(notes.count) notes"
        guard !spaces.isEmpty else { return noteCount }
        let spaceCount = spaces.count == 1 ? "1 space" : "\(spaces.count) spaces"
        return "\(noteCount) across \(spaceCount)"
    }

    /// Only real spaces are cards; notes without a space are simply listed below.
    private var spaceCards: [SpacePresentation] { spaces }

    private var gridColumns: [GridItem] {
        [GridItem(.flexible(), spacing: UnfiledTheme.controlGap), GridItem(.flexible())]
    }

    private func spaceName(for note: NotePresentation) -> String? {
        guard let spaceID = note.spaceID else { return nil }
        return spaces.first { $0.id == spaceID }?.name
    }
}

/// One space as a card: its name and how many notes it holds. Tapping enters it.
private struct SpaceCard: View {
    let space: SpacePresentation
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 6) {
                GlyphView(glyph: .notes, size: 20, weight: 1.9)
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .padding(.bottom, 6)
                Text(space.name)
                    .font(UnfiledType.heading)
                    .foregroundStyle(UnfiledTheme.paper)
                    .lineLimit(1)
                Text(space.noteCount == 1 ? "1 note" : "\(space.noteCount) notes")
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(UnfiledTheme.cardPadding)
            .background(UnfiledTheme.graphite)
            .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .stroke(UnfiledTheme.border, lineWidth: 1)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.unfiledPress)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("library.space.\(space.id)")
    }
}

/// A space's notes, pushed from the Library grid.
struct SpaceNotesView: View {
    let title: String
    let notes: [NotePresentation]
    let onOpenNote: @MainActor (String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ScreenHeader(
                    title: title,
                    subtitle: notes.count == 1 ? "1 note" : "\(notes.count) notes",
                    showsMark: false
                )
                .padding(.bottom, UnfiledTheme.sectionTop)
                SectionRule()
                if notes.isEmpty {
                    EmptyLedgerView(
                        title: "Nothing here yet",
                        message: "Notes filed into this space will appear here."
                    )
                } else {
                    ForEach(notes) { note in
                        Button { onOpenNote(note.id) } label: {
                            NoteLibraryRow(note: note, spaceName: nil)
                        }
                        .buttonStyle(.unfiledPress)
                        .accessibilityIdentifier("notes.row.\(note.id)")
                        SectionRule()
                    }
                }
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, UnfiledTheme.pushedScreenBottom)
        }
        .unfiledScreen()
    }
}

/// A note in the library: the title in the serif, one line of preview, and where and when.
struct NoteLibraryRow: View {
    let note: NotePresentation
    let spaceName: String?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 8) {
                    if note.pinned {
                        GlyphView(glyph: .check, size: 12, weight: 1.8)
                            .foregroundStyle(UnfiledTheme.persimmon)
                    }
                    Text(note.title)
                        .font(UnfiledType.title)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                if !note.preview.isEmpty {
                    Text(note.preview)
                        .font(UnfiledType.body)
                        .foregroundStyle(UnfiledTheme.fog)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
                Text(footer)
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
            }
            Spacer(minLength: 8)
            GlyphView(glyph: .chevron, size: 16, weight: 1.8)
                .foregroundStyle(UnfiledTheme.fog)
                .padding(.top, 6)
        }
        .padding(.vertical, UnfiledTheme.rowVertical)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    private var footer: String {
        var parts: [String] = []
        if let spaceName { parts.append(spaceName) }
        parts.append(note.updatedLabel)
        return parts.joined(separator: "  ·  ")
    }
}

/// Groups notes by recency: pinned first, then today, yesterday, this week, earlier.
enum NoteLibraryGrouping {
    struct Group: Identifiable {
        let title: String
        let notes: [NotePresentation]
        var id: String { title }
    }

    static func groups(for notes: [NotePresentation], now: Date = .now) -> [Group] {
        let calendar = Calendar.current
        var pinned: [NotePresentation] = []
        var today: [NotePresentation] = []
        var yesterday: [NotePresentation] = []
        var week: [NotePresentation] = []
        var earlier: [NotePresentation] = []
        for note in notes {
            if note.pinned {
                pinned.append(note)
                continue
            }
            guard let date = parse(note.updatedAt) else {
                earlier.append(note)
                continue
            }
            if calendar.isDate(date, inSameDayAs: now) {
                today.append(note)
            } else if let previous = calendar.date(byAdding: .day, value: -1, to: now),
                      calendar.isDate(date, inSameDayAs: previous) {
                yesterday.append(note)
            } else if let weekAgo = calendar.date(byAdding: .day, value: -7, to: now), date > weekAgo {
                week.append(note)
            } else {
                earlier.append(note)
            }
        }
        return [
            Group(title: "Pinned", notes: pinned),
            Group(title: "Today", notes: today),
            Group(title: "Yesterday", notes: yesterday),
            Group(title: "This week", notes: week),
            Group(title: "Earlier", notes: earlier)
        ].filter { !$0.notes.isEmpty }
    }

    private static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = fractional.date(from: value) { return date }
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]
        return plain.date(from: value)
    }
}
