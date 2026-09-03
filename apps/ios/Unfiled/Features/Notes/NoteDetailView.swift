import SwiftUI

struct NoteDetailView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @State private var optimisticChecks: [String: Bool] = [:]
    @State private var updatingItemIDs: Set<String> = []
    @State private var showsCompleted = false
    @State private var pendingNoteAction: PendingNoteAction?
    @State private var isPerformingNoteAction = false
    @State private var feedbackMessage: String?

    let note: NoteDetailPresentation
    var isArchived = false
    var generatedBlocks: [GeneratedBlockPresentation] = []
    var isLoadingGeneratedBlocks = false
    var generatedBlocksError: String?
    var hasMoreGeneratedBlocks = false
    var isLoadingMoreGeneratedBlocks = false
    var generatedBlocksLoadMoreError: String?
    var generatedBlocksPaginationNotice: String?
    var submittingInteractionIDs: Set<String> = []
    var interactionErrors: [String: String] = [:]
    let noteContext: NoteContextViewState
    let onEdit: @MainActor () -> Void
    let onShowRevisionHistory: @MainActor () -> Void
    let onOpenProvenance: @MainActor () -> Void
    let onToggleChecklistItem: @MainActor (String, Bool) async throws -> Void
    let onSetArchived: @MainActor (Bool) async throws -> Void
    let onDelete: @MainActor () async throws -> Void
    let onOpenSourceCapture: @MainActor (String) -> Void
    let onOpenBacklink: @MainActor (String) -> Void
    let onUpdateLogField: @MainActor (String, [String], LogFieldValue) async throws -> Void
    var onRefreshGeneratedBlocks: @MainActor () async -> Void = {}
    var onLoadMoreGeneratedBlocks: @MainActor () async -> Void = {}
    var onResolveGeneratedBlock: @MainActor (String, GeneratedBlockResolution) -> Void = { _, _ in }
    var onRefreshNoteContext: @MainActor () async -> Void = {}
    var onLoadMoreSources: @MainActor () async -> Void = {}
    var onLoadMoreBacklinks: @MainActor () async -> Void = {}

    private var progress: ChecklistProgress {
        ChecklistProgress(items: note.checklistItems, overrides: optimisticChecks)
    }

    private var openItems: [ChecklistItemPresentation] {
        note.checklistItems.filter { !resolvedCheck(for: $0) }
    }

    private var completedItems: [ChecklistItemPresentation] {
        note.checklistItems.filter { resolvedCheck(for: $0) }
    }

    private var readableBody: String {
        NoteDetailContent.bodyWithoutChecklistProjection(note.bodyMarkdown)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                noteHeader

                if !readableBody.isEmpty {
                    Text(NoteDetailContent.markdown(readableBody))
                        .font(UnfiledType.thought)
                        .lineSpacing(7)
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.vertical, UnfiledTheme.rowVertical)
                        .accessibilityIdentifier("noteDetail.body")

                    SectionRule()
                }

                if !note.checklistItems.isEmpty {
                    checklist
                    SectionRule()
                }

                if !note.logEntries.isEmpty {
                    LogFieldsSection(entries: note.logEntries, onUpdate: onUpdateLogField)
                        .id("note-log-\(note.id)-\(note.currentRevision)")
                    SectionRule()
                }

                GeneratedBlocksSection(
                    blocks: generatedBlocks,
                    isLoading: isLoadingGeneratedBlocks,
                    loadError: generatedBlocksError,
                    hasMore: hasMoreGeneratedBlocks,
                    isLoadingMore: isLoadingMoreGeneratedBlocks,
                    loadMoreError: generatedBlocksLoadMoreError,
                    paginationNotice: generatedBlocksPaginationNotice,
                    submittingInteractionIDs: submittingInteractionIDs,
                    interactionErrors: interactionErrors,
                    onRefresh: onRefreshGeneratedBlocks,
                    onLoadMore: onLoadMoreGeneratedBlocks,
                    onResolve: onResolveGeneratedBlock
                )

                if !GeneratedBlockVisibility.visible(generatedBlocks).isEmpty ||
                    isLoadingGeneratedBlocks || generatedBlocksError != nil ||
                    hasMoreGeneratedBlocks || isLoadingMoreGeneratedBlocks ||
                    generatedBlocksLoadMoreError != nil ||
                    generatedBlocksPaginationNotice != nil {
                    SectionRule()
                }

                if let feedbackMessage {
                    Label { Text(feedbackMessage) } icon: { GlyphView(glyph: .warning, size: 16, weight: 2) }
                        .font(UnfiledType.secondaryStrong)
                        .foregroundStyle(UnfiledTheme.persimmon)
                        .padding(.vertical, 18)
                        .accessibilityIdentifier("noteDetail.feedback")
                }
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, UnfiledTheme.pushedScreenBottom)
        }
        .toolbar { toolbar }
        .confirmationDialog(
            pendingNoteAction?.title ?? "Update note",
            isPresented: Binding(
                get: { pendingNoteAction != nil },
                set: { if !$0 { pendingNoteAction = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let pendingNoteAction {
                Button(pendingNoteAction.buttonTitle, role: pendingNoteAction.role) {
                    perform(pendingNoteAction)
                }
            }
            Button("Cancel", role: .cancel) { pendingNoteAction = nil }
        } message: {
            Text(pendingNoteAction?.message ?? "")
        }
        .onChange(of: note.currentRevision) { _, _ in
            optimisticChecks.removeAll()
            updatingItemIDs.removeAll()
            feedbackMessage = nil
        }
        .unfiledScreen()
    }

    private var noteHeader: some View {
        VStack(alignment: .leading, spacing: 18) {
            if isArchived {
                Label { Text("Archived") } icon: { GlyphView(glyph: .archive, size: 14, weight: 1.8) }
                    .font(UnfiledType.label)
                    .foregroundStyle(UnfiledTheme.fog)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }

            Text(note.title)
                .font(UnfiledType.display)
                .tracking(-1.7)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("noteDetail.title")

            if !note.spacePath.isEmpty {
                Text(note.spacePath)
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel("Space, \(note.spacePath)")
            }

        }
        .padding(.top, UnfiledTheme.pushedHeaderTop)
        .padding(.bottom, UnfiledTheme.headerBottom)
        .overlay(alignment: .bottom) { SectionRule() }
    }

    private var checklist: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(alignment: .firstTextBaseline) {
                Text("Checklist")
                    .font(UnfiledType.title)
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Text(progress.shortLabel)
                    .font(UnfiledType.label)
                    .foregroundStyle(UnfiledTheme.fog)
            }
            .padding(.top, UnfiledTheme.rowVertical)
            .padding(.bottom, UnfiledTheme.labelToRule)

            ForEach(openItems) { item in
                checklistRow(item)
            }

            if !completedItems.isEmpty {
                Button {
                    if reduceMotion {
                        showsCompleted.toggle()
                    } else {
                        withAnimation(.easeOut(duration: 0.2)) { showsCompleted.toggle() }
                    }
                } label: {
                    HStack {
                        Text("Completed")
                            .font(UnfiledType.heading)
                        Text("\(completedItems.count)")
                            .font(UnfiledType.label)
                            .foregroundStyle(UnfiledTheme.fog)
                        Spacer()
                        Image(systemName: showsCompleted ? "chevron.up" : "chevron.down")
                            .foregroundStyle(UnfiledTheme.fog)
                    }
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityValue(showsCompleted ? "Expanded" : "Collapsed")
                .accessibilityIdentifier("noteDetail.completedToggle")

                if showsCompleted {
                    ForEach(completedItems) { item in
                        checklistRow(item)
                    }
                }
            }
        }
        .padding(.bottom, 14)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Checklist, \(progress.accessibilityLabel)")
    }

    private func checklistRow(_ item: ChecklistItemPresentation) -> some View {
        let isChecked = resolvedCheck(for: item)
        let isUpdating = updatingItemIDs.contains(item.id)

        return Button {
            toggle(item, to: !isChecked)
        } label: {
            HStack(alignment: .center, spacing: 15) {
                ZStack {
                    Circle()
                        .stroke(isChecked ? UnfiledTheme.persimmon : UnfiledTheme.fog, lineWidth: 1.5)
                        .frame(width: 30, height: 30)
                    if isChecked {
                        Circle()
                            .fill(UnfiledTheme.persimmon)
                            .frame(width: 30, height: 30)
                        Image(systemName: "checkmark")
                            .font(UnfiledType.label)
                            .foregroundStyle(UnfiledTheme.ink)
                    } else if isUpdating {
                        ProgressView()
                            .controlSize(.small)
                            .tint(UnfiledTheme.fog)
                    }
                }
                .frame(width: UnfiledTheme.minimumTouchTarget, height: UnfiledTheme.minimumTouchTarget)

                Text(item.text)
                    .font(UnfiledType.body)
                    .foregroundStyle(isChecked ? UnfiledTheme.fog : UnfiledTheme.paper)
                    .strikethrough(isChecked)
                    .multilineTextAlignment(.leading)

                Spacer(minLength: 8)
            }
            .frame(maxWidth: .infinity, minHeight: 62, alignment: .leading)
            .contentShape(Rectangle())
            .overlay(alignment: .bottom) { SectionRule() }
        }
        .buttonStyle(.plain)
        .disabled(isUpdating)
        .accessibilityLabel(item.text)
        .accessibilityValue(
            "\(isChecked ? "Checked" : "Not checked"), \(progress.remaining) remaining"
        )
        .accessibilityHint("Double tap to mark \(isChecked ? "not completed" : "completed")")
        .accessibilityIdentifier("noteDetail.checklist.\(item.id)")
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button(action: onEdit) {
                GlyphView(glyph: .pen, size: 18, weight: 1.9)
                    .foregroundStyle(UnfiledTheme.paper)
                    .frame(minWidth: UnfiledTheme.minimumTouchTarget, minHeight: UnfiledTheme.minimumTouchTarget)
            }
            .accessibilityLabel("Edit")
            .accessibilityIdentifier("noteDetail.edit")

            Menu {
                Button("Revision history", systemImage: "clock.arrow.circlepath") {
                    onShowRevisionHistory()
                }
                Button(
                    isArchived ? "Restore from archive" : "Archive",
                    systemImage: isArchived ? "arrow.uturn.backward" : "archivebox"
                ) {
                    pendingNoteAction = .archive(!isArchived)
                }
                Button("Delete note", systemImage: "trash", role: .destructive) {
                    pendingNoteAction = .delete
                }
            } label: {
                GlyphView(glyph: .more, size: 18, weight: 1.9)
                    .foregroundStyle(UnfiledTheme.paper)
                    .frame(width: UnfiledTheme.minimumTouchTarget, height: UnfiledTheme.minimumTouchTarget)
            }
            .disabled(isPerformingNoteAction)
            .accessibilityLabel("Note actions")
            .accessibilityIdentifier("noteDetail.actions")
        }
    }

    private func resolvedCheck(for item: ChecklistItemPresentation) -> Bool {
        optimisticChecks[item.id] ?? item.checked
    }

    private func toggle(_ item: ChecklistItemPresentation, to checked: Bool) {
        guard !updatingItemIDs.contains(item.id) else { return }
        let previous = resolvedCheck(for: item)
        optimisticChecks[item.id] = checked
        updatingItemIDs.insert(item.id)
        feedbackMessage = nil

        Task { @MainActor in
            do {
                try await onToggleChecklistItem(item.id, checked)
                UIAccessibility.post(
                    notification: .announcement,
                    argument: "\(item.text), \(checked ? "checked" : "not checked")"
                )
            } catch {
                optimisticChecks[item.id] = previous
                feedbackMessage = "That item was not updated. The latest note has been restored."
                UIAccessibility.post(notification: .announcement, argument: feedbackMessage)
            }
            updatingItemIDs.remove(item.id)
        }
    }

    private func perform(_ action: PendingNoteAction) {
        pendingNoteAction = nil
        isPerformingNoteAction = true
        feedbackMessage = nil

        Task { @MainActor in
            do {
                switch action {
                case let .archive(archived):
                    try await onSetArchived(archived)
                case .delete:
                    try await onDelete()
                }
                isPerformingNoteAction = false
            } catch {
                feedbackMessage = action.failureMessage
                isPerformingNoteAction = false
            }
        }
    }
}

private enum PendingNoteAction: Equatable {
    case archive(Bool)
    case delete

    var title: String {
        switch self {
        case .archive(true): "Archive this note?"
        case .archive(false): "Restore this note?"
        case .delete: "Move this note to Recently Deleted?"
        }
    }

    var buttonTitle: String {
        switch self {
        case .archive(true): "Archive"
        case .archive(false): "Restore"
        case .delete: "Delete"
        }
    }

    var message: String {
        switch self {
        case .archive(true): "The note stays available in Archive."
        case .archive(false): "The note returns to your active library."
        case .delete: "You can recover it during the retention window."
        }
    }

    var role: ButtonRole? {
        self == .delete ? .destructive : nil
    }

    var failureMessage: String {
        switch self {
        case .archive(true): "The note was not archived. Try again."
        case .archive(false): "The note was not restored. Try again."
        case .delete: "The note was not deleted. Try again."
        }
    }
}

struct ChecklistProgress: Equatable {
    let completed: Int
    let total: Int

    init(items: [ChecklistItemPresentation], overrides: [String: Bool] = [:]) {
        total = items.count
        completed = items.reduce(into: 0) { count, item in
            if overrides[item.id] ?? item.checked { count += 1 }
        }
    }

    var remaining: Int { max(total - completed, 0) }
    var shortLabel: String { "\(completed) of \(total)" }
    var accessibilityLabel: String {
        "\(completed) completed, \(remaining) remaining"
    }
}

enum NoteDetailContent {
    /// The body without its checklist projection: the checklist lines themselves, and any
    /// heading whose section holds nothing but checklist lines (the "Completed" section).
    static func bodyWithoutChecklistProjection(_ body: String) -> String {
        let lines = body.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        var kept: [String] = []
        var index = 0
        while index < lines.count {
            let line = lines[index]
            if isHeadingLine(line) {
                var end = index + 1
                var sectionHasProse = false
                while end < lines.count, !isHeadingLine(lines[end]) {
                    let body = lines[end].trimmingCharacters(in: .whitespaces)
                    if !body.isEmpty, !isChecklistLine(lines[end]) { sectionHasProse = true }
                    end += 1
                }
                if !sectionHasProse {
                    index = end
                    continue
                }
            }
            if !isChecklistLine(line) { kept.append(line) }
            index += 1
        }
        return kept.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func isHeadingLine(_ line: String) -> Bool {
        line.trimmingCharacters(in: .whitespaces).hasPrefix("#")
    }

    static func markdown(_ source: String) -> AttributedString {
        (try? AttributedString(
            markdown: source,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        )) ?? AttributedString(source)
    }

    private static func isChecklistLine(_ line: String) -> Bool {
        let normalized = line.trimmingCharacters(in: .whitespaces).lowercased()
        return ["- [ ] ", "- [x] ", "* [ ] ", "* [x] ", "+ [ ] ", "+ [x] "]
            .contains { normalized.hasPrefix($0) }
    }
}
