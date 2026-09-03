import SwiftUI

enum NoteContextAccessibilityIdentifier {
    static let sources = "noteDetail.sources"
    static let sourcesLoadMore = "noteDetail.sources.loadMore"
    static let sourcesRetry = "noteDetail.sources.retry"
    static let backlinks = "noteDetail.backlinks"
    static let backlinksLoadMore = "noteDetail.backlinks.loadMore"
    static let backlinksRetry = "noteDetail.backlinks.retry"

    static func source(_ source: NoteSource) -> String {
        "noteDetail.source.\(source.captureId.rawValue).\(source.mutationId.rawValue)"
    }

    static func backlink(_ backlink: NoteBacklink) -> String {
        "noteDetail.backlink.\(backlink.linkId.rawValue)"
    }
}

enum NoteContextPresentation {
    static func sourceLabel(_ source: CaptureSource) -> String {
        switch source {
        case .mobile: "iPhone"
        case .web: "Web"
        case .shareSheet: "Share sheet"
        case .import: "Import"
        case .iosLockScreenWidget: "Lock Screen"
        }
    }

    static func linkLabel(_ linkType: LinkType) -> String {
        switch linkType {
        case .reference: "Reference"
        case .related: "Related"
        }
    }

    static func sourceStatus(_ relation: NoteSourceRelation) -> String {
        switch relation {
        case .routed: "Included in this note"
        case .sourceRemoved: "Removed from this note"
        }
    }
}

struct NoteContextSections: View {
    let state: NoteContextViewState
    let onRefresh: @MainActor () async -> Void
    let onLoadMoreSources: @MainActor () async -> Void
    let onLoadMoreBacklinks: @MainActor () async -> Void
    let onOpenCapture: @MainActor (String) -> Void
    let onOpenNote: @MainActor (String) -> Void

    var body: some View {
        NoteSourcesSection(
            sources: state.sources,
            isLoading: state.isLoadingSources,
            hasLoaded: state.hasLoadedSources,
            isLoadingMore: state.isLoadingMoreSources,
            hasMore: state.hasMoreSources,
            failure: state.sourcesFailure,
            notice: state.sourcesNotice,
            onRefresh: onRefresh,
            onLoadMore: onLoadMoreSources,
            onOpenCapture: onOpenCapture
        )

        SectionRule()

        NoteBacklinksSection(
            backlinks: state.backlinks,
            isLoading: state.isLoadingBacklinks,
            hasLoaded: state.hasLoadedBacklinks,
            isLoadingMore: state.isLoadingMoreBacklinks,
            hasMore: state.hasMoreBacklinks,
            failure: state.backlinksFailure,
            notice: state.backlinksNotice,
            onRefresh: onRefresh,
            onLoadMore: onLoadMoreBacklinks,
            onOpenNote: onOpenNote
        )
    }
}

private struct NoteSourcesSection: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expandedSourceIDs = Set<String>()

    let sources: [NoteSource]
    let isLoading: Bool
    let hasLoaded: Bool
    let isLoadingMore: Bool
    let hasMore: Bool
    let failure: NoteContextFailure?
    let notice: String?
    let onRefresh: @MainActor () async -> Void
    let onLoadMore: @MainActor () async -> Void
    let onOpenCapture: @MainActor (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            contextHeader(
                title: "Sources",
                detail: "Captured inputs that shaped this note",
                count: sources.count,
                isLoading: isLoading
            )

            if isLoading, sources.isEmpty {
                loadingRow("Loading private sources")
            } else if let failure, sources.isEmpty {
                failureRow(
                    failure,
                    retryIdentifier: NoteContextAccessibilityIdentifier.sourcesRetry,
                    retry: onRefresh
                )
            } else if hasLoaded, sources.isEmpty {
                emptyRow(
                    title: "No captured sources",
                    message: "This note has not been updated from a capture yet.",
                    systemImage: "tray"
                )
            } else {
                ForEach(sources, id: \.contextIdentity) { source in
                    sourceRow(source)
                }
                paginationControls(
                    isLoadingMore: isLoadingMore,
                    hasMore: hasMore,
                    failure: failure,
                    loadingLabel: "Loading more sources",
                    identifier: NoteContextAccessibilityIdentifier.sourcesLoadMore,
                    retryIdentifier: NoteContextAccessibilityIdentifier.sourcesRetry,
                    action: onLoadMore
                )
            }

            if let notice, !notice.isEmpty {
                contextNotice(notice)
            }
        }
        .padding(.vertical, UnfiledTheme.rowVertical)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(NoteContextAccessibilityIdentifier.sources)
        .onChange(of: sourceIdentities) { _, current in
            expandedSourceIDs.formIntersection(current)
        }
    }

    private var sourceIdentities: Set<String> {
        Set(sources.map(\.contextIdentity))
    }

    private func sourceRow(_ source: NoteSource) -> some View {
        let identity = source.contextIdentity
        let isExpanded = expandedSourceIDs.contains(identity)
        let isRemoved = source.relation == .sourceRemoved

        return VStack(alignment: .leading, spacing: 0) {
            Button {
                if reduceMotion {
                    toggleSource(identity)
                } else {
                    withAnimation(.easeOut(duration: 0.18)) { toggleSource(identity) }
                }
            } label: {
                HStack(alignment: .center, spacing: 14) {
                    Image(systemName: isRemoved ? "minus.circle" : "tray.and.arrow.down")
                        .font(UnfiledType.heading)
                        .foregroundStyle(isRemoved ? UnfiledTheme.fog : UnfiledTheme.persimmon)
                        .frame(width: 28)

                    VStack(alignment: .leading, spacing: 5) {
                        Text(NoteContextPresentation.sourceLabel(source.source))
                            .font(UnfiledType.heading)
                            .foregroundStyle(UnfiledTheme.paper)
                        Text(source.clientCreatedAt, format: .dateTime.month(.abbreviated)
                            .day().hour().minute())
                            .font(UnfiledType.caption)
                            .foregroundStyle(UnfiledTheme.fog)
                    }

                    Spacer(minLength: 12)

                    if isRemoved {
                        Text("REMOVED")
                            .font(UnfiledType.label)
                            .tracking(0.6)
                            .foregroundStyle(UnfiledTheme.fog)
                    }

                    Image(systemName: isExpanded ? "chevron.up" : "chevron.down")
                        .font(UnfiledType.label)
                        .foregroundStyle(UnfiledTheme.fog)
                }
                .frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(
                "\(NoteContextPresentation.sourceLabel(source.source)) source, " +
                    NoteContextPresentation.sourceStatus(source.relation)
            )
            .accessibilityValue(isExpanded ? "Expanded" : "Collapsed")
            .accessibilityHint("Shows the original captured text")
            .accessibilityIdentifier(NoteContextAccessibilityIdentifier.source(source))

            if isExpanded {
                VStack(alignment: .leading, spacing: 14) {
                    Text(source.rawContent)
                        .font(UnfiledType.body)
                        .lineSpacing(5)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityLabel("Original captured text, \(source.rawContent)")

                    Label(
                        NoteContextPresentation.sourceStatus(source.relation),
                        systemImage: isRemoved ? "minus.circle" : "checkmark.circle"
                    )
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)

                    if !source.insertedItemIds.isEmpty {
                        Text("\(source.insertedItemIds.count) captured " +
                            (source.insertedItemIds.count == 1 ? "item" : "items"))
                            .font(UnfiledType.caption)
                            .foregroundStyle(UnfiledTheme.fog)
                    }

                    Button {
                        onOpenCapture(source.captureId.rawValue)
                    } label: {
                        Label("Open capture", systemImage: "arrow.right")
                            .font(UnfiledType.heading)
                            .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .accessibilityHint("Opens the full capture receipt")
                }
                .padding(.horizontal, 42)
                .padding(.bottom, 18)
            }

            SectionRule()
        }
    }

    private func toggleSource(_ identity: String) {
        if expandedSourceIDs.contains(identity) {
            expandedSourceIDs.remove(identity)
        } else {
            expandedSourceIDs.insert(identity)
        }
    }
}

private extension NoteSource {
    var contextIdentity: String {
        "\(captureId.rawValue)|\(mutationId.rawValue)"
    }
}

private struct NoteBacklinksSection: View {
    let backlinks: [NoteBacklink]
    let isLoading: Bool
    let hasLoaded: Bool
    let isLoadingMore: Bool
    let hasMore: Bool
    let failure: NoteContextFailure?
    let notice: String?
    let onRefresh: @MainActor () async -> Void
    let onLoadMore: @MainActor () async -> Void
    let onOpenNote: @MainActor (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            contextHeader(
                title: "Backlinks",
                detail: "Notes that point here",
                count: backlinks.count,
                isLoading: isLoading
            )

            if isLoading, backlinks.isEmpty {
                loadingRow("Loading private backlinks")
            } else if let failure, backlinks.isEmpty {
                failureRow(
                    failure,
                    retryIdentifier: NoteContextAccessibilityIdentifier.backlinksRetry,
                    retry: onRefresh
                )
            } else if hasLoaded, backlinks.isEmpty {
                emptyRow(
                    title: "No backlinks yet",
                    message: "Other notes that link here will appear in this list.",
                    systemImage: "link"
                )
            } else {
                ForEach(backlinks, id: \.linkId) { backlink in
                    Button {
                        onOpenNote(backlink.fromNoteId.rawValue)
                    } label: {
                        HStack(alignment: .center, spacing: 14) {
                            Image(systemName: "arrow.turn.down.right")
                                .font(UnfiledType.heading)
                                .foregroundStyle(UnfiledTheme.persimmon)
                                .frame(width: 28)

                            VStack(alignment: .leading, spacing: 5) {
                                Text(backlink.fromTitle)
                                    .font(UnfiledType.heading)
                                    .foregroundStyle(UnfiledTheme.paper)
                                    .multilineTextAlignment(.leading)
                                Text(NoteContextPresentation.linkLabel(backlink.linkType))
                                    .font(UnfiledType.caption)
                                    .foregroundStyle(UnfiledTheme.fog)
                            }

                            Spacer(minLength: 12)
                            Image(systemName: "arrow.right")
                                .font(UnfiledType.label)
                                .foregroundStyle(UnfiledTheme.fog)
                        }
                        .frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
                        .contentShape(Rectangle())
                        .overlay(alignment: .bottom) { SectionRule() }
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(
                        "\(backlink.fromTitle), " +
                            NoteContextPresentation.linkLabel(backlink.linkType) + " backlink"
                    )
                    .accessibilityHint("Opens the note that links here")
                    .accessibilityIdentifier(NoteContextAccessibilityIdentifier.backlink(backlink))
                }

                paginationControls(
                    isLoadingMore: isLoadingMore,
                    hasMore: hasMore,
                    failure: failure,
                    loadingLabel: "Loading more backlinks",
                    identifier: NoteContextAccessibilityIdentifier.backlinksLoadMore,
                    retryIdentifier: NoteContextAccessibilityIdentifier.backlinksRetry,
                    action: onLoadMore
                )
            }

            if let notice, !notice.isEmpty {
                contextNotice(notice)
            }
        }
        .padding(.vertical, UnfiledTheme.rowVertical)
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(NoteContextAccessibilityIdentifier.backlinks)
    }
}

@MainActor
private func contextHeader(
    title: String,
    detail: String,
    count: Int,
    isLoading: Bool
) -> some View {
    HStack(alignment: .center, spacing: 12) {
        VStack(alignment: .leading, spacing: 5) {
            Text(title)
                .font(UnfiledType.title)
                .accessibilityAddTraits(.isHeader)
            Text(detail)
                .font(UnfiledType.caption)
                .foregroundStyle(UnfiledTheme.fog)
        }
        Spacer(minLength: 12)
        if isLoading {
            ProgressView()
                .controlSize(.small)
                .tint(UnfiledTheme.persimmon)
                .accessibilityHidden(true)
        } else if count > 0 {
            Text("\(count)")
                .font(UnfiledType.label)
                .foregroundStyle(UnfiledTheme.fog)
                .accessibilityLabel("\(count) loaded")
        }
    }
}

@MainActor
private func loadingRow(_ label: String) -> some View {
    Label(label, systemImage: "clock")
        .font(UnfiledType.caption)
        .foregroundStyle(UnfiledTheme.fog)
        .frame(minHeight: UnfiledTheme.minimumTouchTarget)
}

@MainActor
private func emptyRow(title: String, message: String, systemImage: String) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        Label(title, systemImage: systemImage)
            .font(UnfiledType.heading)
            .foregroundStyle(UnfiledTheme.paper)
        Text(message)
            .font(UnfiledType.secondary)
            .foregroundStyle(UnfiledTheme.fog)
            .fixedSize(horizontal: false, vertical: true)
    }
    .padding(.vertical, 8)
}

@MainActor
private func failureRow(
    _ failure: NoteContextFailure,
    retryIdentifier: String,
    retry: @escaping @MainActor () async -> Void
) -> some View {
    VStack(alignment: .leading, spacing: 8) {
        Label(failure.title, systemImage: failure.systemImage)
            .font(UnfiledType.heading)
            .foregroundStyle(UnfiledTheme.paper)
        Text(failure.message)
            .font(UnfiledType.secondary)
            .foregroundStyle(UnfiledTheme.fog)
            .fixedSize(horizontal: false, vertical: true)
        if failure != .deleted {
            Button("Try again") { Task { await retry() } }
                .font(UnfiledType.heading)
                .foregroundStyle(UnfiledTheme.persimmon)
                .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                .accessibilityIdentifier(retryIdentifier)
        }
    }
}

@ViewBuilder
@MainActor
private func paginationControls(
    isLoadingMore: Bool,
    hasMore: Bool,
    failure: NoteContextFailure?,
    loadingLabel: String,
    identifier: String,
    retryIdentifier: String,
    action: @escaping @MainActor () async -> Void
) -> some View {
    if isLoadingMore {
        loadingRow(loadingLabel)
            .accessibilityIdentifier(identifier)
    } else if let failure {
        failureRow(failure, retryIdentifier: retryIdentifier, retry: action)
    } else if hasMore {
        Button {
            Task { await action() }
        } label: {
            Label("Load more", systemImage: "arrow.down")
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
        .accessibilityHint("Loads the next private page without replacing items already shown")
        .accessibilityIdentifier(identifier)
    }
}

@MainActor
private func contextNotice(_ notice: String) -> some View {
    Label(notice, systemImage: "info.circle")
        .font(UnfiledType.secondary)
        .foregroundStyle(UnfiledTheme.fog)
        .fixedSize(horizontal: false, vertical: true)
}
