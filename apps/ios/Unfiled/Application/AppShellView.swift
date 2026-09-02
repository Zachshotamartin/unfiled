import SwiftUI

struct AppShellView: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var model: AppModel

    var body: some View {
        NavigationStack(path: $model.navigationPath) {
            selectedTab
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    BottomLedgerNavigation(
                        selectedTab: $model.selectedTab,
                        reviewCount: model.reviewItems.count,
                        onCapture: {
                            Task { @MainActor in await model.prepareCapture(source: .mobile) }
                        }
                    )
                }
                .navigationDestination(for: AppRoute.self) { route in
                    destination(route)
                }
        }
        .sheet(item: $model.captureSheet) { sheet in
            ZStack {
                CaptureComposerView(
                    source: sheet.source,
                    composerGeneration: sheet.composerGeneration,
                    initialContent: sheet.initialContent,
                    initialPrivacy: sheet.initialPrivacy,
                    restoredDraft: sheet.restoredDraft,
                    onSave: model.saveCapture,
                    onDraftChange: model.saveCaptureDraft,
                    onDiscardDraft: model.discardCaptureDraft
                )
                if scenePhase != .active {
                    PrivacyCurtainView()
                        .zIndex(100)
                }
            }
        }
        .sheet(item: $model.editorSheet) { sheet in
            ZStack {
                NavigationStack {
                    NoteEditorView(
                        draft: sheet.draft,
                        spaces: model.spaces,
                        currentRevision: sheet.currentRevision,
                        onCancel: { model.editorSheet = nil },
                        onSave: { draft in
                            try await model.saveNote(
                                draft,
                                expectedRevision: sheet.currentRevision
                            )
                        }
                    )
                }
                if scenePhase != .active {
                    PrivacyCurtainView()
                        .zIndex(100)
                }
            }
        }
        .sheet(item: $model.destinationPickerSheet) { sheet in
            ZStack {
                DestinationPickerView(
                    sheet: sheet,
                    notes: model.notes,
                    spaces: model.spaces,
                    isSubmitting: model.isSubmittingInteraction(sheet.purpose.operationID),
                    errorMessage: model.interactionError(for: sheet.purpose.operationID),
                    onCancel: { model.destinationPickerSheet = nil },
                    onSubmit: { choice in
                        await model.submitDestination(choice, for: sheet)
                    }
                )
                if scenePhase != .active {
                    PrivacyCurtainView()
                        .zIndex(100)
                }
            }
        }
    }

    @ViewBuilder
    private var selectedTab: some View {
        switch model.selectedTab {
        case .today:
            TodayView(
                receipts: model.receipts,
                isLoading: model.isLoadingLibrary,
                submittingInteractionIDs: model.submittingInteractionIDs,
                interactionErrors: model.interactionErrors,
                onRefresh: model.refreshAll,
                onOpenSettings: { model.navigationPath.append(.settings) },
                onOpenCapture: model.openCapture,
                onOpenNote: model.openNote,
                onMove: model.presentCorrection,
                onUndo: { captureID, mutationID, expectedRevision in
                    Task { @MainActor in
                        await model.undoReceipt(
                            captureID: captureID,
                            mutationID: mutationID,
                            expectedRevision: expectedRevision
                        )
                    }
                },
                onShowReview: { model.showReview(reviewID: $0) },
                onRetryCapture: { captureID in
                    Task { @MainActor in await model.retryCapture(captureID: captureID) }
                },
                onCapture: {
                    Task { @MainActor in await model.prepareCapture(source: .mobile) }
                }
            )
        case .notes:
            NotesLibraryView(
                notes: model.notes,
                spaces: model.spaces,
                isLoading: model.isLoadingLibrary,
                onRefresh: model.refreshAll,
                onOpenNote: model.openNote,
                onCreateNote: model.presentNewNote,
                onOpenArchive: { model.navigationPath.append(.archive) },
                onOpenDeleted: { model.navigationPath.append(.deleted) }
            )
        case .review:
            ReviewView(
                items: model.reviewItems,
                isLoading: model.isLoadingReview,
                errorMessage: model.reviewError,
                submittingInteractionIDs: model.submittingInteractionIDs,
                interactionErrors: model.interactionErrors,
                requestedFocusID: model.requestedReviewFocusID,
                onRefresh: model.refreshAll,
                onOpenRelatedNote: model.openNote,
                onAction: { reviewID, action in
                    Task { @MainActor in
                        await model.handleReviewAction(reviewID: reviewID, action: action)
                    }
                }
            )
        case .search:
            SearchView(
                results: model.searchResults,
                isLoading: model.isSearching,
                errorMessage: model.searchError,
                onSearch: model.search,
                onOpenNote: model.openNote
            )
        }
    }

    @ViewBuilder
    private func destination(_ route: AppRoute) -> some View {
        switch route {
        case let .note(noteID):
            NoteDestinationView(model: model, noteID: noteID)
        case let .capture(captureID):
            CaptureReceiptDestinationView(model: model, captureID: captureID)
        case let .revisions(noteID):
            RevisionHistoryDestinationView(model: model, noteID: noteID)
        case let .revisionPreview(_, revisionID):
            if let snapshot = model.revisionSnapshots[revisionID] {
                RevisionSnapshotView(snapshot: snapshot)
            } else {
                LoadingDestinationView(label: "Loading revision")
            }
        case .archive:
            LibrarySubsetView(
                title: "Archive",
                eyebrow: "Kept out of the way",
                notes: model.archiveNotes,
                isDeleted: false,
                onRefresh: model.loadArchive,
                onOpen: model.openNote,
                onRestore: { noteID in
                    try await model.setArchived(noteID: noteID, archived: false)
                    await model.loadArchive()
                }
            )
            .task { await model.loadArchive() }
        case .deleted:
            LibrarySubsetView(
                title: "Recently deleted",
                eyebrow: "Recoverable notes",
                notes: model.deletedNotes,
                isDeleted: true,
                onRefresh: model.loadDeleted,
                onOpen: { _ in },
                onRestore: model.restoreDeleted
            )
            .task { await model.loadDeleted() }
        case .settings:
            SettingsView(
                email: model.currentUser?.email ?? "",
                apiHost: model.apiHostLabel,
                onOpenRoutingRules: { model.navigationPath.append(.routingRules) },
                onSignOut: model.signOut
            )
        case .routingRules:
            RoutingRulesView(
                rules: model.routingRules,
                notes: model.notes,
                spaces: model.spaces,
                isLoading: model.isLoadingRoutingRules,
                hasLoaded: model.hasLoadedRoutingRules,
                errorMessage: model.routingRulesError,
                submittingRuleIDs: model.routingRuleSubmittingIDs,
                onRefresh: model.loadRoutingRules,
                onSave: model.saveRoutingRule,
                onSetEnabled: { ruleID, enabled in
                    await model.setRoutingRuleEnabled(ruleID: ruleID, enabled: enabled)
                },
                onAccept: { ruleID in
                    await model.acceptRoutingRuleProposal(ruleID: ruleID)
                },
                onRemove: { ruleID in
                    await model.removeRoutingRule(ruleID: ruleID)
                }
            )
            .task {
                if !model.hasLoadedRoutingRules { await model.loadRoutingRules() }
            }
        }
    }
}

private struct CaptureReceiptDestinationView: View {
    @ObservedObject var model: AppModel
    let captureID: String

    var body: some View {
        CaptureReceiptDetailView(
            receipt: model.captureDetail(captureID),
            isLoading: model.captureDetailLoadingIDs.contains(captureID),
            errorMessage: model.captureDetailErrors[captureID],
            submittingInteractionIDs: model.submittingInteractionIDs,
            interactionErrors: model.interactionErrors,
            onRefresh: { await model.loadCaptureDetail(captureID: captureID) },
            onOpenNote: model.openNote,
            onMove: model.presentCorrection,
            onUndo: { receiptCaptureID, mutationID, expectedRevision in
                Task { @MainActor in
                    await model.undoReceipt(
                        captureID: receiptCaptureID,
                        mutationID: mutationID,
                        expectedRevision: expectedRevision
                    )
                }
            },
            onShowReview: { model.showReview(reviewID: $0) }
        )
        .task { await model.loadCaptureDetail(captureID: captureID) }
    }
}

private struct BottomLedgerNavigation: View {
    @Binding var selectedTab: MainTab
    let reviewCount: Int
    let onCapture: @MainActor () -> Void

    var body: some View {
        HStack(spacing: 2) {
            tab(.today)
            tab(.notes)

            Button(action: onCapture) {
                Image(systemName: "plus")
                    .font(.system(size: 23, weight: .semibold))
                    .foregroundStyle(UnfiledTheme.ink)
                    .frame(width: 58, height: 58)
                    .background(UnfiledTheme.persimmon)
                    .clipShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Write something")
            .padding(.horizontal, 4)

            tab(.review)
            tab(.search)
        }
        .padding(.horizontal, 8)
        .padding(.top, 9)
        .padding(.bottom, 5)
        .background(UnfiledTheme.graphite)
        .overlay(alignment: .top) { SectionRule() }
    }

    private func tab(_ tab: MainTab) -> some View {
        Button {
            selectedTab = tab
        } label: {
            VStack(spacing: 3) {
                ZStack(alignment: .topTrailing) {
                    Image(systemName: tab.systemImage)
                        .font(.system(size: 19, weight: .medium))
                    if tab == .review && reviewCount > 0 {
                        Text("\(min(reviewCount, 99))")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundStyle(UnfiledTheme.ink)
                            .padding(.horizontal, 4)
                            .frame(minHeight: 15)
                            .background(UnfiledTheme.persimmon)
                            .clipShape(Capsule())
                            .offset(x: 12, y: -8)
                    }
                }
                Text(tab.rawValue)
                    .font(.system(size: 10, weight: .medium))
            }
            .foregroundStyle(selectedTab == tab ? UnfiledTheme.paper : UnfiledTheme.fog)
            .frame(maxWidth: .infinity, minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(tab.rawValue)
        .accessibilityAddTraits(selectedTab == tab ? .isSelected : [])
    }
}

private struct NoteDestinationView: View {
    @ObservedObject var model: AppModel
    let noteID: String

    var body: some View {
        Group {
            if let note = model.noteDetail(noteID) {
                NoteDetailView(
                    note: note,
                    isArchived: model.isArchived(noteID),
                    generatedBlocks: model.generatedBlocksByNoteID[noteID] ?? [],
                    isLoadingGeneratedBlocks: model.generatedBlockLoadingNoteIDs.contains(noteID),
                    generatedBlocksError: model.generatedBlockErrors[noteID],
                    hasMoreGeneratedBlocks: model.generatedBlockHasMoreNoteIDs.contains(noteID),
                    isLoadingMoreGeneratedBlocks: model.generatedBlockLoadingMoreNoteIDs.contains(
                        noteID
                    ),
                    generatedBlocksLoadMoreError: model.generatedBlockLoadMoreErrors[noteID],
                    generatedBlocksPaginationNotice: model.generatedBlockPaginationNotices[noteID],
                    submittingInteractionIDs: model.submittingInteractionIDs,
                    interactionErrors: model.interactionErrors,
                    onEdit: {
                        Task { @MainActor in await model.presentEditor(noteID: noteID) }
                    },
                    onShowRevisionHistory: {
                        model.navigationPath.append(.revisions(noteID))
                    },
                    onOpenProvenance: {
                        model.selectedTab = .today
                        model.navigationPath = []
                    },
                    onToggleChecklistItem: { itemID, checked in
                        try await model.toggleChecklistItem(
                            noteID: noteID,
                            itemID: itemID,
                            checked: checked
                        )
                    },
                    onSetArchived: { archived in
                        try await model.setArchived(noteID: noteID, archived: archived)
                    },
                    onDelete: {
                        try await model.deleteNote(noteID: noteID)
                    },
                    onRefreshGeneratedBlocks: {
                        await model.loadGeneratedBlocks(noteID: noteID, force: true)
                    },
                    onLoadMoreGeneratedBlocks: {
                        await model.loadMoreGeneratedBlocks(noteID: noteID)
                    },
                    onResolveGeneratedBlock: { blockID, resolution in
                        Task { @MainActor in
                            await model.resolveGeneratedBlock(
                                blockID: blockID,
                                resolution: resolution
                            )
                        }
                    }
                )
            } else {
                LoadingDestinationView(label: "Loading note")
            }
        }
        .task(id: noteID) {
            _ = await model.loadNote(noteID)
            await model.loadGeneratedBlocks(noteID: noteID)
        }
    }
}

private struct RevisionHistoryDestinationView: View {
    @ObservedObject var model: AppModel
    let noteID: String

    var body: some View {
        Group {
            if let note = model.noteDetail(noteID) {
                RevisionHistoryView(
                    noteTitle: note.title,
                    currentRevision: note.currentRevision,
                    revisions: model.revisions[noteID] ?? [],
                    isLoading: model.revisions[noteID] == nil,
                    errorMessage: nil,
                    onRefresh: { await model.loadRevisions(noteID: noteID) },
                    onPreviewRevision: { revisionID in
                        model.navigationPath.append(
                            .revisionPreview(noteID: noteID, revisionID: revisionID)
                        )
                    },
                    onRestoreRevision: { revisionID, expectedRevision in
                        try await model.restoreRevision(
                            noteID: noteID,
                            revisionID: revisionID,
                            expectedRevision: expectedRevision
                        )
                    }
                )
            } else {
                LoadingDestinationView(label: "Loading history")
            }
        }
        .task(id: noteID) {
            _ = await model.loadNote(noteID)
            await model.loadRevisions(noteID: noteID)
        }
    }
}

private struct RevisionSnapshotView: View {
    let snapshot: NoteDetailPresentation

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                EditorialEyebrow(text: "Read-only · Revision \(snapshot.currentRevision)")
                Text(snapshot.title)
                    .font(.system(size: 38, weight: .bold))
                    .tracking(-1.3)
                Text(snapshot.spacePath)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(UnfiledTheme.fog)
                SectionRule()
                Text(NoteDetailContent.markdown(snapshot.bodyMarkdown))
                    .font(.system(size: 17))
                    .lineSpacing(6)
                    .textSelection(.enabled)
            }
            .padding(UnfiledTheme.screenPadding)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle("Revision \(snapshot.currentRevision)")
        .navigationBarTitleDisplayMode(.inline)
        .unfiledScreen()
    }
}

private struct LoadingDestinationView: View {
    let label: String

    var body: some View {
        ProgressView(label)
            .tint(UnfiledTheme.persimmon)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .unfiledScreen()
    }
}
