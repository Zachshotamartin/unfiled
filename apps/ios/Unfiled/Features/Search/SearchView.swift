import SwiftUI

@MainActor
enum SearchQueryDebouncer {
    static let defaultDelay: Duration = .milliseconds(320)

    static func dispatch(
        request: SearchRequest,
        delay: Duration = defaultDelay,
        action: @escaping @MainActor (SearchRequest) -> Void
    ) async {
        if request.hasQuery {
            do {
                try await Task.sleep(for: delay)
            } catch {
                return
            }
        }

        guard !Task.isCancelled else { return }
        action(request)
    }
}

struct SearchView: View {
    @Binding private var query: String
    @State private var includesArchived: Bool
    @State private var scope: SearchScope
    @State private var submittedRequest: SearchRequest

    let results: [SearchResultPresentation]
    let isLoading: Bool
    let failure: SearchFailure?
    let hasMore: Bool
    let isLoadingMore: Bool
    let loadMoreFailure: SearchFailure?
    let paginationNotice: String?
    let openingResultIDs: Set<String>
    let deletedResultIDs: Set<String>
    let resultFailures: [String: SearchFailure]
    let debounceDuration: Duration
    let onSearch: @MainActor (SearchRequest) -> Void
    let onLoadMore: @MainActor () async -> Void
    let onOpenNote: @MainActor (String) async -> Void
    /// False when the Library shows search in place of itself.
    let showsHeader: Bool
    /// Leaves search when the Library hosts it.
    let onLeave: (@MainActor () -> Void)?
    /// Embedded under another screen's field: only the controls and results, no scroll or header.
    let embedded: Bool
    @FocusState private var fieldFocused: Bool

    init(
        results: [SearchResultPresentation],
        isLoading: Bool,
        failure: SearchFailure? = nil,
        hasMore: Bool = false,
        isLoadingMore: Bool = false,
        loadMoreFailure: SearchFailure? = nil,
        paginationNotice: String? = nil,
        openingResultIDs: Set<String> = [],
        deletedResultIDs: Set<String> = [],
        resultFailures: [String: SearchFailure] = [:],
        query: Binding<String>,
        embedded: Bool = false,
        includesArchived: Bool = false,
        initialScope: SearchScope = .all,
        debounceDuration: Duration = SearchQueryDebouncer.defaultDelay,
        onSearch: @escaping @MainActor (SearchRequest) -> Void,
        onLoadMore: @escaping @MainActor () async -> Void = {},
        onOpenNote: @escaping @MainActor (String) async -> Void,
        showsHeader: Bool = true,
        onLeave: (@MainActor () -> Void)? = nil
    ) {
        self.results = results
        self.isLoading = isLoading
        self.failure = failure
        self.hasMore = hasMore
        self.isLoadingMore = isLoadingMore
        self.loadMoreFailure = loadMoreFailure
        self.paginationNotice = paginationNotice
        self.openingResultIDs = openingResultIDs
        self.deletedResultIDs = deletedResultIDs
        self.resultFailures = resultFailures
        self.debounceDuration = debounceDuration
        self.onSearch = onSearch
        self.onLoadMore = onLoadMore
        self.onOpenNote = onOpenNote
        self.showsHeader = showsHeader
        self.onLeave = onLeave
        _query = query
        self.embedded = embedded
        _includesArchived = State(initialValue: includesArchived)
        _scope = State(initialValue: initialScope)
        _submittedRequest = State(
            initialValue: SearchRequest(
                query: query.wrappedValue,
                includesArchived: includesArchived,
                scope: initialScope
            )
        )
    }

    private var request: SearchRequest {
        SearchRequest(query: query, includesArchived: includesArchived, scope: scope)
    }

    var body: some View {
        if embedded {
            embeddedBody
        } else {
            standaloneBody
        }
    }

    private var embeddedBody: some View {
        LazyVStack(alignment: .leading, spacing: 0) {
            scopeControl
            archiveControl
            if request.hasQuery {
                resultsHeader
            }
            SectionRule()
            content
        }
        .task(id: request) {
            await SearchQueryDebouncer.dispatch(
                request: request,
                delay: debounceDuration
            ) { submittedRequest in
                self.submittedRequest = submittedRequest
                onSearch(submittedRequest)
            }
        }
    }

    private var standaloneBody: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if showsHeader {
                    header
                        .padding(.bottom, UnfiledTheme.sectionTop)
                } else {
                    ScreenHeader(title: "Search", subtitle: "Exact text across every note.") {
                        if let onLeave {
                            IconButton(glyph: .close, label: "Leave search", action: onLeave)
                        }
                    }
                    .padding(.bottom, UnfiledTheme.sectionTop)
                }
                searchField
                scopeControl
                archiveControl
                if request.hasQuery {
                    resultsHeader
                }
                SectionRule()
                content
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, UnfiledTheme.screenBottom)
        }
        .scrollDismissesKeyboard(.interactively)
        .onAppear {
            if onLeave != nil { fieldFocused = true }
        }
        .task(id: request) {
            await SearchQueryDebouncer.dispatch(
                request: request,
                delay: debounceDuration
            ) { submittedRequest in
                self.submittedRequest = submittedRequest
                onSearch(submittedRequest)
            }
        }
        .unfiledScreen()
    }

    private var header: some View {
        ScreenHeader(title: "Search", subtitle: "Exact text across every note.")
            .accessibilityIdentifier("search.title")
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            GlyphView(glyph: .search, size: 18, weight: 1.8)
                .foregroundStyle(UnfiledTheme.fog)

            TextField("Search your notes", text: $query)
                .font(UnfiledType.body)
                .focused($fieldFocused)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .foregroundStyle(UnfiledTheme.paper)
                .onChange(of: query) { _, value in
                    query = SearchInputRules.bounded(value)
                }
                .accessibilityLabel("Search your notes")
                .accessibilityIdentifier("search.query")

            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    GlyphView(glyph: .close, size: 16, weight: 1.8)
                        .foregroundStyle(UnfiledTheme.fog)
                        .frame(width: UnfiledTheme.minimumTouchTarget, height: UnfiledTheme.minimumTouchTarget)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
                .accessibilityIdentifier("search.clear")
            }
        }
        .padding(.leading, UnfiledTheme.fieldPadding)
        .padding(.trailing, query.isEmpty ? UnfiledTheme.fieldPadding : 4)
        .frame(minHeight: UnfiledTheme.controlHeight)
        .background(UnfiledTheme.graphite)
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .overlay {
            RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                .stroke(UnfiledTheme.border, lineWidth: 1)
        }
    }

    private var scopeControl: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: UnfiledTheme.controlGap) {
                ForEach(SearchScope.allCases, id: \.self) { option in
                    Chip(title: option.title, selected: scope == option) { scope = option }
                        .accessibilityLabel("\(option.title), \(option.detail)")
                        .accessibilityValue(scope == option ? "Selected" : "Not selected")
                        .accessibilityIdentifier("search.scope.\(option.rawValue)")
                }
                Spacer()
            }
            Text(scope.detail)
                .font(UnfiledType.caption)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 16)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("search.scope")
    }

    private var archiveControl: some View {
        Toggle(isOn: $includesArchived) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Include archived notes")
                    .font(UnfiledType.body)
                Text("Archived matches stay marked in the results.")
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .tint(UnfiledTheme.persimmon)
        .frame(minHeight: 60)
        .padding(.vertical, 10)
        .accessibilityIdentifier("search.includeArchived")
    }

    private var resultsHeader: some View {
        HStack(alignment: .center, spacing: 12) {
            EditorialEyebrow(text: resultCountLabel)
            Spacer(minLength: 12)
            if searchIsPending {
                UnfiledLoadingView(size: 18, label: "Searching notes")
                    .accessibilityIdentifier("search.loading.inline")
            }
        }
        .padding(.top, 22)
        .padding(.bottom, UnfiledTheme.labelToRule)
    }

    private var resultCountLabel: String {
        guard request.hasQuery else { return "Results" }
        guard !searchIsPending else { return "Searching" }
        switch visibleResults.count {
        case 0: return "No matches"
        case 1: return "1 match"
        default: return "\(visibleResults.count) matches"
        }
    }

    @ViewBuilder
    private var content: some View {
        if !request.hasQuery {
            EmptyLedgerView(
                title: "Find any thought",
                message: "Search by what you remember. Titles, note text, and destinations all work."
            )
            .accessibilityIdentifier("search.prompt")
        } else if visibleResults.isEmpty {
            if searchIsPending {
                SearchLoadingLedgerView()
            } else if let failure = visibleFailure {
                SearchErrorLedgerView(failure: failure, onRetry: retry)
            } else {
                EmptyLedgerView(
                    title: "No match",
                    message: includesArchived
                        ? "Try a different phrase or fewer words."
                        : "Try a different phrase, or include archived notes."
                )
                .accessibilityIdentifier("search.empty")
            }
        } else {
            if let failure = visibleFailure {
                SearchErrorLedgerView(failure: failure, onRetry: retry)
            }

            ForEach(visibleResults) { result in
                if deletedResultIDs.contains(result.id) {
                    SearchDeletedResultLedgerRow(result: result)
                        .accessibilityIdentifier("search.result.\(result.id).deleted")
                } else {
                    Button {
                        Task { await onOpenNote(result.id) }
                    } label: {
                        SearchResultLedgerRow(
                            result: result,
                            isOpening: openingResultIDs.contains(result.id)
                        )
                    }
                    .buttonStyle(.plain)
                    .disabled(openingResultIDs.contains(result.id))
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(result.accessibilitySummary)
                    .accessibilityValue(
                        openingResultIDs.contains(result.id) ? "Opening" : "Available"
                    )
                    .accessibilityHint("Opens note")
                    .accessibilityIdentifier("search.result.\(result.id)")

                    if let resultFailure = resultFailures[result.id] {
                        Label(resultFailure.message, systemImage: resultFailure.systemImage)
                            .font(UnfiledType.secondary)
                            .foregroundStyle(UnfiledTheme.persimmon)
                            .padding(.vertical, 8)
                            .accessibilityIdentifier("search.result.\(result.id).error")
                    }
                }
                SectionRule()
            }

            if request == submittedRequest {
                searchPagination
            }
        }
    }

    private var visibleResults: [SearchResultPresentation] {
        request == submittedRequest ? results : []
    }

    private var visibleFailure: SearchFailure? {
        request == submittedRequest ? failure : nil
    }

    private var searchIsPending: Bool {
        request.hasQuery && (request != submittedRequest || isLoading)
    }

    @ViewBuilder
    private var searchPagination: some View {
        if isLoadingMore {
            HStack(spacing: 12) {
                UnfiledLoadingView(size: 18).tint(UnfiledTheme.persimmon)
                Text("Loading more results")
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
            }
            .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            .accessibilityIdentifier("search.loadMore.loading")
        } else if let loadMoreFailure {
            SearchErrorLedgerView(failure: loadMoreFailure) {
                Task { await onLoadMore() }
            }
            .accessibilityIdentifier("search.loadMore.error")
        } else if let paginationNotice {
            Label(paginationNotice, systemImage: "line.3.horizontal.decrease.circle")
                .font(UnfiledType.secondary)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.minimumTouchTarget, alignment: .leading)
                .padding(.vertical, 12)
                .accessibilityIdentifier("search.pagination.notice")
        } else if hasMore {
            Button {
                Task { await onLoadMore() }
            } label: {
                Label("Load more results", systemImage: "arrow.down")
                    .font(UnfiledType.heading)
                    .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(UnfiledTheme.paper)
            .background(UnfiledTheme.graphite)
            .overlay {
                RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                    .stroke(UnfiledTheme.border, lineWidth: 1)
            }
            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            .padding(.vertical, 18)
            .accessibilityHint("Loads the next private page without replacing current results")
            .accessibilityIdentifier("search.loadMore")
        }
    }

    @MainActor
    private func retry() {
        onSearch(request)
    }
}

private extension SearchResultPresentation {
    var accessibilitySummary: String {
        [title, type, path, snippet, updatedLabel]
            .filter { !$0.isEmpty }
            .joined(separator: ", ")
    }
}

private struct SearchResultLedgerRow: View {
    let result: SearchResultPresentation
    let isOpening: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                EditorialEyebrow(text: result.type)
                Spacer(minLength: 12)
                Text(result.updatedLabel)
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
                    .multilineTextAlignment(.trailing)
            }

            Text(result.title)
                .font(UnfiledType.title)
                .foregroundStyle(UnfiledTheme.paper)
                .fixedSize(horizontal: false, vertical: true)

            Text(result.snippet)
                .font(UnfiledType.body)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .center, spacing: 10) {
                if !result.path.isEmpty {
                    Text(result.path)
                        .font(UnfiledType.caption)
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                if isOpening {
                    UnfiledLoadingView(size: 18)
                } else {
                    Label { Text("Open note") } icon: { GlyphView(glyph: .chevron, size: 14, weight: 1.8) }
                        .font(UnfiledType.secondaryStrong)
                        .foregroundStyle(UnfiledTheme.persimmon)
                        .labelStyle(.titleAndIcon)
                }
            }
        }
        .frame(maxWidth: .infinity, minHeight: 126, alignment: .leading)
        .padding(.vertical, UnfiledTheme.rowVertical)
        .contentShape(Rectangle())
    }
}

private struct SearchDeletedResultLedgerRow: View {
    let result: SearchResultPresentation

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Deleted note", systemImage: "trash")
                .font(UnfiledType.heading)
                .foregroundStyle(UnfiledTheme.fog)
            Text(result.title)
                .font(UnfiledType.heading)
                .foregroundStyle(UnfiledTheme.fog)
            Text("This result was deleted after the search. Run the search again to refresh the list.")
                .font(UnfiledType.secondary)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 112, alignment: .leading)
        .padding(.vertical, UnfiledTheme.rowVertical)
        .accessibilityElement(children: .combine)
    }
}

private struct SearchLoadingLedgerView: View {
    var body: some View {
        HStack(spacing: 14) {
            UnfiledLoadingView(size: 18)
            VStack(alignment: .leading, spacing: 4) {
                Text("Searching your notes")
                    .font(UnfiledType.heading)
                Text("Looking for the closest matches.")
                    .font(UnfiledType.body)
                    .foregroundStyle(UnfiledTheme.fog)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 128, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Searching your notes")
        .accessibilityIdentifier("search.loading")
    }
}

private struct SearchErrorLedgerView: View {
    let failure: SearchFailure
    let onRetry: @MainActor () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label(failure.title, systemImage: failure.systemImage)
                .font(UnfiledType.heading)
                .foregroundStyle(UnfiledTheme.paper)
            Text(failure.message)
                .font(UnfiledType.body)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
            Button("Try again", action: onRetry)
                .font(UnfiledType.heading)
                .foregroundStyle(UnfiledTheme.persimmon)
                .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                .accessibilityHint("Repeats the current search")
                .accessibilityIdentifier("search.retry")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, UnfiledTheme.rowVertical)
        .accessibilityIdentifier("search.error")
    }
}
