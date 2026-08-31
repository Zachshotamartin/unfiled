import SwiftUI

struct SearchRequest: Hashable, Sendable {
    let query: String
    let includesArchived: Bool

    init(query: String, includesArchived: Bool) {
        self.query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        self.includesArchived = includesArchived
    }

    var hasQuery: Bool { !query.isEmpty }
}

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
    @State private var query: String
    @State private var includesArchived: Bool

    let results: [SearchResultPresentation]
    let isLoading: Bool
    let errorMessage: String?
    let debounceDuration: Duration
    let onSearch: @MainActor (String, Bool) -> Void
    let onOpenNote: @MainActor (String) -> Void

    init(
        results: [SearchResultPresentation],
        isLoading: Bool,
        errorMessage: String? = nil,
        initialQuery: String = "",
        includesArchived: Bool = false,
        debounceDuration: Duration = SearchQueryDebouncer.defaultDelay,
        onSearch: @escaping @MainActor (String, Bool) -> Void,
        onOpenNote: @escaping @MainActor (String) -> Void
    ) {
        self.results = results
        self.isLoading = isLoading
        self.errorMessage = errorMessage
        self.debounceDuration = debounceDuration
        self.onSearch = onSearch
        self.onOpenNote = onOpenNote
        _query = State(initialValue: initialQuery)
        _includesArchived = State(initialValue: includesArchived)
    }

    private var request: SearchRequest {
        SearchRequest(query: query, includesArchived: includesArchived)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header
                searchField
                archiveControl
                resultsHeader
                SectionRule()
                content
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, 110)
        }
        .scrollDismissesKeyboard(.interactively)
        .task(id: request) {
            await SearchQueryDebouncer.dispatch(
                request: request,
                delay: debounceDuration
            ) { submittedRequest in
                onSearch(submittedRequest.query, submittedRequest.includesArchived)
            }
        }
        .unfiledScreen()
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 18) {
            UnfiledMark(size: 32)
            Text("Search")
                .font(.largeTitle.weight(.bold))
                .tracking(-1.2)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("search.title")
            Text("Find a phrase, destination, or detail across your notes.")
                .font(.body)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 12)
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.body.weight(.medium))
                .foregroundStyle(UnfiledTheme.fog)
                .accessibilityHidden(true)

            TextField("Search your notes", text: $query)
                .font(.body)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .foregroundStyle(UnfiledTheme.paper)
                .accessibilityLabel("Search your notes")
                .accessibilityIdentifier("search.query")

            if !query.isEmpty {
                Button {
                    query = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title3)
                        .foregroundStyle(UnfiledTheme.fog)
                        .frame(width: UnfiledTheme.minimumTouchTarget, height: UnfiledTheme.minimumTouchTarget)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Clear search")
                .accessibilityIdentifier("search.clear")
            }
        }
        .padding(.leading, 16)
        .padding(.trailing, query.isEmpty ? 16 : 4)
        .frame(minHeight: 56)
        .background(UnfiledTheme.graphite)
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .overlay {
            RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                .stroke(UnfiledTheme.border, lineWidth: 1)
        }
        .padding(.top, 26)
    }

    private var archiveControl: some View {
        Toggle(isOn: $includesArchived) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Include archived notes")
                    .font(.body.weight(.medium))
                Text("Archived matches stay marked in the results.")
                    .font(.caption)
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
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(resultCountLabel.uppercased())
                .font(.caption.weight(.medium).monospaced())
                .tracking(1)
                .foregroundStyle(UnfiledTheme.fog)
            Spacer(minLength: 12)
            if isLoading && request.hasQuery {
                ProgressView()
                    .controlSize(.small)
                    .tint(UnfiledTheme.persimmon)
                    .accessibilityLabel("Searching notes")
                    .accessibilityIdentifier("search.loading.inline")
            }
        }
        .padding(.top, 22)
        .padding(.bottom, 14)
    }

    private var resultCountLabel: String {
        guard request.hasQuery else { return "Results" }
        guard !isLoading else { return "Searching" }
        switch results.count {
        case 0: return "No matches"
        case 1: return "1 match"
        default: return "\(results.count) matches"
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
        } else if results.isEmpty {
            if isLoading {
                SearchLoadingLedgerView()
            } else if let error = normalizedError {
                SearchErrorLedgerView(message: error, onRetry: retry)
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
            if let error = normalizedError {
                SearchErrorLedgerView(message: error, onRetry: retry)
            }

            ForEach(results) { result in
                Button {
                    onOpenNote(result.id)
                } label: {
                    SearchResultLedgerRow(result: result)
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(result.accessibilitySummary)
                .accessibilityHint("Opens note")
                .accessibilityIdentifier("search.result.\(result.id)")
                SectionRule()
            }
        }
    }

    private var normalizedError: String? {
        guard let errorMessage else { return nil }
        let trimmed = errorMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    @MainActor
    private func retry() {
        onSearch(request.query, request.includesArchived)
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

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Text(result.type.uppercased())
                    .font(.caption.weight(.medium).monospaced())
                    .tracking(0.9)
                    .foregroundStyle(UnfiledTheme.fog)
                Spacer(minLength: 12)
                Text(result.updatedLabel)
                    .font(.caption.monospaced())
                    .foregroundStyle(UnfiledTheme.fog)
                    .multilineTextAlignment(.trailing)
            }

            Text(result.title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(UnfiledTheme.paper)
                .fixedSize(horizontal: false, vertical: true)

            Text(result.snippet)
                .font(.body)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)

            HStack(alignment: .firstTextBaseline, spacing: 10) {
                if !result.path.isEmpty {
                    Text(result.path)
                        .font(.caption.monospaced())
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 12)
                Label("Open note", systemImage: "arrow.right")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .labelStyle(.titleAndIcon)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 126, alignment: .leading)
        .padding(.vertical, 22)
        .contentShape(Rectangle())
    }
}

private struct SearchLoadingLedgerView: View {
    var body: some View {
        HStack(spacing: 14) {
            ProgressView()
                .tint(UnfiledTheme.persimmon)
            VStack(alignment: .leading, spacing: 4) {
                Text("Searching your notes")
                    .font(.headline)
                Text("Looking for the closest matches.")
                    .font(.body)
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
    let message: String
    let onRetry: @MainActor () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Label("Search is unavailable", systemImage: "exclamationmark.circle")
                .font(.headline)
                .foregroundStyle(UnfiledTheme.paper)
            Text(message)
                .font(.body)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
            Button("Try again", action: onRetry)
                .font(.body.weight(.semibold))
                .foregroundStyle(UnfiledTheme.persimmon)
                .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                .accessibilityHint("Repeats the current search")
                .accessibilityIdentifier("search.retry")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 24)
        .accessibilityIdentifier("search.error")
    }
}
