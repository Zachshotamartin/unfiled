import SwiftUI

struct AppShellView: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var model: AppModel

    var body: some View {
        NavigationStack(path: $model.navigationPath) {
            ZStack {
                selectedTab
                    .id(model.selectedTab)
                    .transition(UnfiledMotion.page)
            }
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
                    onSave: { content, privacy, source, generation in
                        try await model.saveCapture(
                            content: content,
                            privacy: privacy,
                            source: source,
                            composerGeneration: generation
                        )
                    },
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
                        failureMessage: sheet.failureMessage,
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
        case .inbox:
            InboxView(
                receipts: model.receipts,
                reviewItems: model.reviewItems,
                isLoading: model.isLoadingLibrary || model.isLoadingReview,
                needsProviderKey: model.providerKeyMetadataByProvider.isEmpty,
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
                onEditCapture: { captureID in
                    Task { @MainActor in await model.editCapture(captureID: captureID) }
                },
                onOrganizeAgain: { captureID, guidance in
                    Task { @MainActor in await model.organizeAgain(captureID: captureID, guidance: guidance) }
                },
                onDeleteCapture: { captureID in
                    Task { @MainActor in await model.deleteCapture(captureID: captureID) }
                },
                onCapture: {
                    Task { @MainActor in await model.prepareCapture(source: .mobile) }
                },
                onReviewAction: { reviewID, action in
                    Task { @MainActor in
                        await model.handleReviewAction(reviewID: reviewID, action: action)
                    }
                }
            )
        case .library:
            LibraryView(
                notes: model.notes,
                spaces: model.spaces,
                isLoading: model.isLoadingLibrary,
                onRefresh: model.refreshAll,
                onOpenNote: model.openNote,
                onOpenSpace: { model.navigationPath.append(.space($0)) },
                onOpenArchive: { model.navigationPath.append(.archive) },
                onOpenDeleted: { model.navigationPath.append(.deleted) }
            ) { query in
                SearchView(
                    results: model.searchResults,
                    isLoading: model.isSearching,
                    failure: model.searchFailure,
                    hasMore: model.searchHasMore,
                    isLoadingMore: model.isLoadingMoreSearch,
                    loadMoreFailure: model.searchLoadMoreFailure,
                    paginationNotice: model.searchPaginationNotice,
                    openingResultIDs: model.searchOpeningResultIDs,
                    deletedResultIDs: model.searchDeletedResultIDs,
                    resultFailures: model.searchResultFailures,
                    query: query,
                    embedded: true,
                    onSearch: model.search,
                    onLoadMore: model.loadMoreSearch,
                    onOpenNote: model.openSearchResult,
                    showsHeader: false
                )
            }
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
        case let .review(reviewID):
            ReviewView(
                items: model.reviewItems.filter { $0.id == reviewID },
                isLoading: model.isLoadingReview,
                errorMessage: model.reviewError,
                submittingInteractionIDs: model.submittingInteractionIDs,
                interactionErrors: model.interactionErrors,
                requestedFocusID: reviewID,
                onRefresh: model.refreshAll,
                onOpenRelatedNote: model.openNote,
                onAction: { id, action in
                    Task { @MainActor in
                        await model.handleReviewAction(reviewID: id, action: action)
                    }
                }
            )
            .onChange(of: model.reviewItems.map(\.id)) { _, ids in
                if !model.isLoadingReview, !ids.contains(reviewID) {
                    model.closeReviewPage(reviewID: reviewID)
                }
            }
            .onChange(of: model.isLoadingReview) { _, loading in
                if !loading, !model.reviewItems.contains(where: { $0.id == reviewID }) {
                    model.closeReviewPage(reviewID: reviewID)
                }
            }
        case .settings:
            SettingsView(
                email: model.currentUser?.email ?? "",
                apiHost: model.apiHostLabel,
                aiSettings: model.aiSettings,
                providerKeys: model.providerKeyMetadataByProvider,
                isManagedFallbackAvailable: model.isManagedAIFallbackAvailable,
                isLoadingAISettings: model.isLoadingAISettings,
                hasLoadedAISettings: model.hasLoadedAISettings,
                isSavingAISettings: model.isSavingAISettings,
                hasPendingAISettingsRetry: model.hasPendingAISettingsRetry,
                providerKeyMutation: model.providerKeyMutation,
                pendingProviderKeyRetry: model.pendingProviderKeyRetryProvider,
                aiSettingsError: model.aiSettingsError,
                providerKeyErrors: model.providerKeyErrors,
                accountExportArtifact: model.accountExportArtifact,
                isPreparingAccountExport: model.isPreparingAccountExport,
                accountExportError: model.accountExportError,
                isDeletingAccount: model.isDeletingAccount,
                hasPendingAccountDeletionReplay: model.hasPendingAccountDeletionReplay,
                accountDeletionError: model.accountDeletionError,
                onRefreshAISettings: model.loadAISettings,
                onSaveAISettings: model.saveAISettings,
                onDiscardAISettingsRetry: model.discardAISettingsRetry,
                onSaveProviderKey: model.saveProviderKey,
                onDiscardProviderKeyRetry: model.discardProviderKeyRetry,
                onDeleteProviderKey: model.deleteProviderKey,
                onPrepareAccountExport: model.prepareAccountExport,
                onDiscardAccountExport: model.discardAccountExport,
                onDeleteAccount: model.deleteAccount,
                onOpenRoutingRules: { model.navigationPath.append(.routingRules) },
                onSignOut: model.signOut
            )
        case let .space(spaceID):
            SpaceNotesView(
                title: spaceID.flatMap { id in model.spaces.first { $0.id == id }?.name } ?? "Library",
                notes: model.notes.filter { $0.spaceID == spaceID },
                onOpenNote: model.openNote
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
            reviewOpen: model.reviewItems.contains { $0.id == model.captureDetail(captureID)?.reviewItemID },
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
            onShowReview: { model.showReview(reviewID: $0) },
            onEditCapture: { captureID in
                Task { @MainActor in await model.editCapture(captureID: captureID) }
            },
            onOrganizeAgain: { captureID, guidance in
                Task { @MainActor in await model.organizeAgain(captureID: captureID, guidance: guidance) }
            },
            onDeleteCapture: { captureID in
                Task { @MainActor in await model.deleteCapture(captureID: captureID) }
            }
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
            tab(.inbox)

            Button {
                UnfiledHaptics.tap()
                onCapture()
            } label: {
                GlyphView(glyph: .pen, size: 24, weight: 2.2)
                    .foregroundStyle(UnfiledTheme.ink)
                    .frame(width: 56, height: 56)
                    .background(UnfiledTheme.persimmon)
                    .clipShape(Circle())
            }
            .buttonStyle(UnfiledPressStyle(scale: 0.9))
            .accessibilityLabel("Write something")
            .padding(.horizontal, 4)

            tab(.library)
        }
        .padding(.horizontal, 8)
        .padding(.top, 9)
        .padding(.bottom, 5)
        .background(UnfiledTheme.graphite)
        .overlay(alignment: .top) { SectionRule() }
    }

    private func tab(_ tab: MainTab) -> some View {
        Button {
            guard selectedTab != tab else { return }
            UnfiledHaptics.selection()
            withAnimation(UnfiledMotion.animation(UnfiledMotion.settle)) {
                selectedTab = tab
            }
        } label: {
            VStack(spacing: 3) {
                ZStack(alignment: .topTrailing) {
                    GlyphView(glyph: tab.glyph, size: 22, weight: 1.9)
                        .glyphNudge(on: selectedTab == tab)
                    if tab == .inbox && reviewCount > 0 {
                        Text("\(min(reviewCount, 99))")
                            .font(UnfiledType.label)
                            .foregroundStyle(UnfiledTheme.ink)
                            .padding(.horizontal, 4)
                            .frame(minHeight: 15)
                            .background(UnfiledTheme.persimmon)
                            .clipShape(Capsule())
                            .offset(x: 12, y: -8)
                    }
                }
                Text(tab.rawValue)
                    .font(UnfiledType.label)
            }
            .foregroundStyle(selectedTab == tab ? UnfiledTheme.paper : UnfiledTheme.fog)
            .frame(maxWidth: .infinity, minHeight: 48)
            .background {
                if selectedTab == tab {
                    Capsule()
                        .fill(UnfiledTheme.raised)
                        .padding(.horizontal, 6)
                        .padding(.vertical, 2)
                        .transition(UnfiledMotion.bubble)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.unfiledPress)
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
                    noteContext: model.noteContext(
                        noteID: noteID,
                        revision: note.currentRevision
                    ),
                    onEdit: {
                        Task { @MainActor in await model.presentEditor(noteID: noteID) }
                    },
                    onShowRevisionHistory: {
                        model.navigationPath.append(.revisions(noteID))
                    },
                    onOpenProvenance: {
                        model.selectedTab = .inbox
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
                    onOpenSourceCapture: model.openCapture,
                    onOpenBacklink: model.openNote,
                    onUpdateLogField: { entryID, fieldPath, value in
                        try await model.updateLogField(
                            noteID: noteID,
                            entryID: entryID,
                            fieldPath: fieldPath,
                            value: value
                        )
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
                    },
                    onRefreshNoteContext: {
                        await model.loadNoteContext(noteID: noteID, force: true)
                    },
                    onLoadMoreSources: {
                        await model.loadMoreNoteSources(noteID: noteID)
                    },
                    onLoadMoreBacklinks: {
                        await model.loadMoreNoteBacklinks(noteID: noteID)
                    }
                )
            } else {
                LoadingDestinationView(label: "Loading note")
            }
        }
        .task(id: "\(noteID):\(model.noteDetail(noteID)?.currentRevision ?? 0)") {
            _ = await model.loadNote(noteID)
            async let generatedBlocks: Void = model.loadGeneratedBlocks(noteID: noteID)
            async let noteContext: Void = model.loadNoteContext(noteID: noteID)
            _ = await (generatedBlocks, noteContext)
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
                    .font(UnfiledType.display)
                    .tracking(-1.3)
                Text(snapshot.spacePath)
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
                SectionRule()
                Text(NoteDetailContent.markdown(snapshot.bodyMarkdown))
                    .font(UnfiledType.body)
                    .lineSpacing(6)
                    .textSelection(.enabled)
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.top, UnfiledTheme.pushedHeaderTop)
            .padding(.bottom, UnfiledTheme.pushedScreenBottom)
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
