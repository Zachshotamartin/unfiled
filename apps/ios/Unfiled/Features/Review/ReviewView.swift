import SwiftUI

enum ReviewNavigation: Sendable {
    static func identifier(for reviewID: String) -> String {
        "review.openNote.\(reviewID)"
    }
}

enum ReviewAccessibilityIdentifier {
    static func choice(reviewID: String, noteID: String) -> String {
        "review.choice.\(reviewID).\(noteID)"
    }

    static func chooseNote(_ reviewID: String) -> String { "review.chooseNote.\(reviewID)" }
    static func newNote(_ reviewID: String) -> String { "review.newNote.\(reviewID)" }
    static func keepInbox(_ reviewID: String) -> String { "review.keepInbox.\(reviewID)" }
    static func dismiss(_ reviewID: String) -> String { "review.dismiss.\(reviewID)" }
    static func keepBoth(_ reviewID: String) -> String { "review.keepBoth.\(reviewID)" }
    static func acceptExpansion(_ reviewID: String) -> String {
        "review.acceptExpansion.\(reviewID)"
    }
    static func rejectExpansion(_ reviewID: String) -> String {
        "review.rejectExpansion.\(reviewID)"
    }
}

struct ReviewQueueSummary: Equatable, Sendable {
    let count: Int

    var label: String {
        switch count {
        case 0: "Nothing awaiting review"
        case 1: "1 item awaiting review"
        default: "\(count) items awaiting review"
        }
    }
}

struct ReviewView: View {
    let items: [ReviewPresentation]
    let isLoading: Bool
    let errorMessage: String?
    let submittingInteractionIDs: Set<String>
    let interactionErrors: [String: String]
    let requestedFocusID: String?
    let onRefresh: @MainActor () async -> Void
    let onOpenRelatedNote: @MainActor (String) -> Void
    let onAction: @MainActor (String, ReviewUserAction) -> Void

    @AccessibilityFocusState private var focusedReviewID: String?

    init(
        items: [ReviewPresentation],
        isLoading: Bool,
        errorMessage: String? = nil,
        submittingInteractionIDs: Set<String> = [],
        interactionErrors: [String: String] = [:],
        requestedFocusID: String? = nil,
        onRefresh: @escaping @MainActor () async -> Void = {},
        onOpenRelatedNote: @escaping @MainActor (String) -> Void,
        onAction: @escaping @MainActor (String, ReviewUserAction) -> Void = { _, _ in }
    ) {
        self.items = items
        self.isLoading = isLoading
        self.errorMessage = errorMessage
        self.submittingInteractionIDs = submittingInteractionIDs
        self.interactionErrors = interactionErrors
        self.requestedFocusID = requestedFocusID
        self.onRefresh = onRefresh
        self.onOpenRelatedNote = onOpenRelatedNote
        self.onAction = onAction
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.bottom, UnfiledTheme.sectionTop)
                queueHeader
                SectionRule()
                queueContent
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, UnfiledTheme.screenBottom)
        }
        .refreshable { await onRefresh() }
        .onAppear { focusRequestedItem() }
        .onChange(of: requestedFocusID) { _, _ in focusRequestedItem() }
        .onChange(of: items.map(\.id)) { previous, current in
            if let focusedReviewID, !current.contains(focusedReviewID) {
                self.focusedReviewID = current.first
            } else if previous != current {
                focusRequestedItem()
            }
        }
        .unfiledScreen()
    }

    private var header: some View {
        ScreenHeader(title: "Review", subtitle: "A capture that needs your decision.", showsMark: false)
            .accessibilityIdentifier("review.title")
    }

    private var queueHeader: some View {
        HStack(alignment: .center, spacing: 12) {
            EditorialEyebrow(text: ReviewQueueSummary(count: items.count).label)
            Spacer(minLength: 12)
            if isLoading {
                UnfiledLoadingView(size: 18, label: "Refreshing review queue")
                    .accessibilityIdentifier("review.loading.inline")
            }
        }
        .padding(.bottom, UnfiledTheme.labelToRule)
    }

    @ViewBuilder
    private var queueContent: some View {
        if let error = normalizedError {
            ReviewErrorLedgerView(message: error, onRetry: onRefresh)
            if !items.isEmpty { SectionRule() }
        }

        if items.isEmpty {
            if normalizedError != nil {
                EmptyView()
            } else if isLoading {
                ReviewLoadingLedgerView()
            } else {
                EmptyLedgerView(
                    title: "Everything has a place",
                    message: "Captures that still need a decision are safe in Inbox and will wait here."
                )
                .accessibilityIdentifier("review.empty")
            }
        } else {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                let generatedOperationID = item.generatedBlock?.operationID
                ReviewLedgerRow(
                    item: item,
                    position: index + 1,
                    total: items.count,
                    isSubmitting: submittingInteractionIDs.contains("review.\(item.id)") ||
                        generatedOperationID.map { submittingInteractionIDs.contains($0) } == true,
                    errorMessage: generatedOperationID.flatMap { interactionErrors[$0] }
                        ?? interactionErrors["review.\(item.id)"],
                    actionsDisabled: isLoading,
                    onOpenRelatedNote: onOpenRelatedNote,
                    onAction: onAction
                )
                .accessibilityFocused($focusedReviewID, equals: item.id)
                SectionRule()
            }
        }
    }

    private var normalizedError: String? {
        guard let errorMessage else { return nil }
        let trimmed = errorMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private func focusRequestedItem() {
        guard let requestedFocusID, items.contains(where: { $0.id == requestedFocusID }) else {
            return
        }
        focusedReviewID = requestedFocusID
    }
}

struct ReviewLedgerRow: View {
    let item: ReviewPresentation
    let position: Int
    let total: Int
    let isSubmitting: Bool
    let errorMessage: String?
    let actionsDisabled: Bool
    let onOpenRelatedNote: @MainActor (String) -> Void
    let onAction: @MainActor (String, ReviewUserAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Label("Needs your input", systemImage: "tray.and.arrow.down")
                    .font(UnfiledType.label)
                    .textCase(.uppercase)
                    .foregroundStyle(UnfiledTheme.fog)
                Spacer(minLength: 12)
                Text("\(position.formatted(.number.precision(.integerLength(2)))) / \(total.formatted(.number.precision(.integerLength(2))))")
                    .font(UnfiledType.caption.monospacedDigit())
                    .foregroundStyle(UnfiledTheme.fog)
            }

            Text(item.original)
                .font(UnfiledType.title)
                .foregroundStyle(UnfiledTheme.paper)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Original capture: \(item.original)")

            VStack(alignment: .leading, spacing: 12) {
                EditorialEyebrow(text: "Why it stopped")
                Text(item.actionSummary)
                    .font(UnfiledType.body)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
                Label(item.proposedDestination, systemImage: "arrow.turn.down.right")
                    .font(UnfiledType.title)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, UnfiledTheme.rowVertical)
            .overlay(alignment: .top) { SectionRule() }
            .overlay(alignment: .bottom) { SectionRule() }

            if !item.relatedNotes.isEmpty {
                relatedNotes
            }

            if item.type == .duplicateSuggestion {
                if let explanation = item.duplicateExplanation {
                    VStack(alignment: .leading, spacing: 8) {
                        EditorialEyebrow(text: "Why Unfiled suggested this")
                        Text(explanation)
                            .font(UnfiledType.body)
                            .foregroundStyle(UnfiledTheme.paper)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    .accessibilityLabel("Why Unfiled suggested this: \(explanation)")
                    .accessibilityIdentifier("review.duplicateExplanation.\(item.id)")
                }
                Text("Keeping both changes neither note. Dismiss also leaves both notes untouched.")
                    .font(UnfiledType.secondary)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityLabel(
                        "No destructive action. Keeping both or dismissing changes neither note."
                    )
            }

            if item.allows(.route) {
                destinationChoices
            }

            if let generatedBlock = item.generatedBlock {
                generatedProposal(generatedBlock)
            } else if item.type == .pendingExpansion {
                Text(
                    item.allows(.dismiss)
                        ? "No generated text was persisted. Dismiss removes only this legacy consent hold."
                        : "The persisted AI-generated proposal is unavailable. Refresh before deciding; your note text is unchanged."
                )
                .font(UnfiledType.secondary)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
            }

            actionControls

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.circle")
                    .font(UnfiledType.secondary)
                    .foregroundStyle(UnfiledTheme.paper)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("review.error.\(item.id)")
            }

            Label("Original preserved", systemImage: "doc.badge.clock")
                .font(UnfiledType.caption)
                .foregroundStyle(UnfiledTheme.fog)
                .accessibilityLabel("Original capture preserved")
        }
        .padding(.vertical, UnfiledTheme.rowVertical)
        .accessibilityIdentifier("review.item.\(item.id)")
    }

    private var relatedNotes: some View {
        VStack(alignment: .leading, spacing: 10) {
            EditorialEyebrow(text: "Related notes")
            ForEach(item.relatedNotes) { note in
                Button {
                    onOpenRelatedNote(note.id)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(note.title)
                                .font(UnfiledType.heading)
                                .fixedSize(horizontal: false, vertical: true)
                            Text("Revision \(note.revision)")
                                .font(UnfiledType.caption.monospacedDigit())
                                .foregroundStyle(UnfiledTheme.fog)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "arrow.right")
                            .font(UnfiledType.label)
                            .accessibilityHidden(true)
                    }
                    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(allActionsDisabled)
                .accessibilityLabel("Open \(note.title)")
                .accessibilityIdentifier("review.related.\(item.id).\(note.id)")
            }
        }
    }

    private var destinationChoices: some View {
        VStack(alignment: .leading, spacing: UnfiledTheme.controlGap) {
            EditorialEyebrow(text: "Suggested destinations")
            ForEach(item.suggestedDestinations.prefix(3)) { destination in
                Button {
                    onAction(item.id, .route(noteID: destination.id))
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "arrow.turn.down.right")
                            .font(UnfiledType.label)
                            .foregroundStyle(UnfiledTheme.persimmon)
                            .accessibilityHidden(true)
                        Text(destination.title)
                            .font(UnfiledType.heading)
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                    }
                    .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight, alignment: .leading)
                    .padding(.horizontal, UnfiledTheme.fieldPadding)
                    .background(UnfiledTheme.graphite)
                    .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                }
                .buttonStyle(.plain)
                .disabled(allActionsDisabled)
                .accessibilityLabel("File in \(destination.title)")
                .accessibilityIdentifier(
                    ReviewAccessibilityIdentifier.choice(
                        reviewID: item.id,
                        noteID: destination.id
                    )
                )
            }

            Button {
                onAction(item.id, .chooseDestination)
            } label: {
                Text(item.suggestedDestinations.isEmpty ? "Choose a note" : "Choose another note")
                    .font(UnfiledType.heading)
                    .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            }
            .buttonStyle(.plain)
            .foregroundStyle(UnfiledTheme.persimmon)
            .disabled(allActionsDisabled)
            .accessibilityIdentifier(ReviewAccessibilityIdentifier.chooseNote(item.id))
        }
    }

    private func generatedProposal(_ block: GeneratedBlockPresentation) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("AI-GENERATED · \(block.kindLabel.uppercased())")
                    .font(UnfiledType.label)
                    .tracking(0.8)
                    .foregroundStyle(UnfiledTheme.persimmon)
                Spacer(minLength: 8)
                Text(block.stateLabel.uppercased())
                    .font(UnfiledType.label)
                    .foregroundStyle(UnfiledTheme.fog)
            }
            Text(block.content)
                .font(UnfiledType.body)
                .lineSpacing(5)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            Text(block.provenanceLabel)
                .font(UnfiledType.caption)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
            Text("This stays separate from editable note text.")
                .font(UnfiledType.caption)
                .foregroundStyle(UnfiledTheme.fog)
        }
        .padding(UnfiledTheme.cardPadding)
        .overlay(alignment: .leading) {
            Rectangle().fill(UnfiledTheme.persimmon).frame(width: 3)
        }
        .background(UnfiledTheme.graphite)
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(block.reviewAccessibilityLabel)
        .accessibilityIdentifier("review.generatedBlock.\(item.id).\(block.id)")
    }

    private var actionControls: some View {
        VStack(alignment: .leading, spacing: UnfiledTheme.controlGap) {
            if isSubmitting {
                Label("Saving your choice", systemImage: "clock")
                    .font(UnfiledType.heading)
                    .foregroundStyle(UnfiledTheme.fog)
                    .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                    .accessibilityIdentifier("review.submitting.\(item.id)")
            }

            if item.allows(.create) || item.allows(.route) {
                reviewButton(
                    title: "Let Unfiled decide",
                    systemImage: "sparkles",
                    prominence: .primary,
                    identifier: "review.decide.\(item.id)",
                    accessibilityHint: "Files it where the organizer suggested, or starts a note of the kind it detected"
                ) { onAction(item.id, .decide) }
            }

            if item.allows(.create) {
                reviewButton(
                    title: item.suggestedNewNote.map { "New note: \($0.title)" } ?? "New note",
                    systemImage: "plus",
                    prominence: .secondary,
                    identifier: ReviewAccessibilityIdentifier.newNote(item.id)
                ) { onAction(item.id, .createNote) }
            }

            if item.allows(.keepBoth) {
                reviewButton(
                    title: "Keep both notes",
                    systemImage: "doc.on.doc",
                    prominence: .primary,
                    identifier: ReviewAccessibilityIdentifier.keepBoth(item.id)
                ) { onAction(item.id, .keepBoth) }
            }

            if item.allows(.acceptExpansion) {
                reviewButton(
                    title: "Accept generated addition",
                    systemImage: "checkmark",
                    prominence: .primary,
                    identifier: ReviewAccessibilityIdentifier.acceptExpansion(item.id),
                    accessibilityHint: "Keeps it separately without rewriting note text"
                ) { onAction(item.id, .acceptExpansion) }
            }

            if item.allows(.rejectExpansion) {
                reviewButton(
                    title: "Reject generated addition",
                    systemImage: "xmark",
                    prominence: .secondary,
                    identifier: ReviewAccessibilityIdentifier.rejectExpansion(item.id),
                    accessibilityHint: "Rejects it without changing note text"
                ) { onAction(item.id, .rejectExpansion) }
            }

            if item.captureID != nil {
                reviewButton(
                    title: "Edit text",
                    systemImage: "pencil",
                    prominence: .secondary,
                    identifier: "review.editText.\(item.id)",
                    accessibilityHint: "Opens the capture's text to change it before filing"
                ) { onAction(item.id, .editText) }
            }

            if item.allows(.dismiss) {
                reviewButton(
                    title: "Not now",
                    systemImage: "xmark",
                    prominence: .secondary,
                    identifier: ReviewAccessibilityIdentifier.dismiss(item.id),
                    accessibilityHint: "Closes this review; the capture stays in the Inbox"
                ) { onAction(item.id, .dismiss) }
            }
        }
    }

    private enum Prominence { case primary, secondary }

    private func reviewButton(
        title: String,
        systemImage: String,
        prominence: Prominence,
        identifier: String,
        accessibilityHint: String = "",
        action: @escaping @MainActor () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(UnfiledType.heading)
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(prominence == .primary ? UnfiledTheme.ink : UnfiledTheme.paper)
        .background(prominence == .primary ? UnfiledTheme.persimmon : UnfiledTheme.graphite)
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .disabled(allActionsDisabled)
        .opacity(allActionsDisabled && !isSubmitting ? 0.5 : 1)
        .accessibilityHint(accessibilityHint)
        .accessibilityIdentifier(identifier)
    }

    private var allActionsDisabled: Bool {
        actionsDisabled || isSubmitting
    }
}

private struct ReviewLoadingLedgerView: View {
    var body: some View {
        HStack(spacing: 14) {
            ProgressView().tint(UnfiledTheme.persimmon)
            VStack(alignment: .leading, spacing: 4) {
                Text("Loading review queue").font(UnfiledType.heading)
                Text("Checking for captures that need your decision.")
                    .font(UnfiledType.body)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 128, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Loading review queue")
        .accessibilityIdentifier("review.loading")
    }
}

private struct ReviewErrorLedgerView: View {
    let message: String
    let onRetry: @MainActor () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .center, spacing: 8) {
                GlyphView(glyph: .warning, size: 18, weight: 1.9)
                Text("Review queue is unavailable")
            }
            .font(UnfiledType.heading)
            Text(message)
                .font(UnfiledType.body)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                Task { await onRetry() }
            } label: {
                Text("Try again")
                    .font(UnfiledType.heading)
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            }
            .accessibilityIdentifier("review.retry")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, UnfiledTheme.rowVertical)
        .accessibilityIdentifier("review.error")
    }
}
