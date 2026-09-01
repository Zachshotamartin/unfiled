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
                queueHeader
                SectionRule()
                queueContent
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, 110)
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
        VStack(alignment: .leading, spacing: 18) {
            UnfiledMark(size: 32)
            Text("Review")
                .font(.largeTitle.weight(.bold))
                .tracking(-1.2)
                .accessibilityAddTraits(.isHeader)
                .accessibilityIdentifier("review.title")
            Text("Resolve only the captures that need your decision. Everything else stays out of the way.")
                .font(.body)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 12)
    }

    private var queueHeader: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(ReviewQueueSummary(count: items.count).label.uppercased())
                .font(.caption.weight(.medium).monospaced())
                .tracking(1)
                .foregroundStyle(UnfiledTheme.fog)
            Spacer(minLength: 12)
            if isLoading {
                ProgressView()
                    .controlSize(.small)
                    .tint(UnfiledTheme.persimmon)
                    .accessibilityLabel("Refreshing review queue")
                    .accessibilityIdentifier("review.loading.inline")
            }
        }
        .padding(.top, 30)
        .padding(.bottom, 14)
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
                ReviewLedgerRow(
                    item: item,
                    position: index + 1,
                    total: items.count,
                    isSubmitting: submittingInteractionIDs.contains("review.\(item.id)"),
                    errorMessage: interactionErrors["review.\(item.id)"],
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

private struct ReviewLedgerRow: View {
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
                    .font(.caption.weight(.medium).monospaced())
                    .textCase(.uppercase)
                    .foregroundStyle(UnfiledTheme.fog)
                Spacer(minLength: 12)
                Text("\(position.formatted(.number.precision(.integerLength(2)))) / \(total.formatted(.number.precision(.integerLength(2))))")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(UnfiledTheme.fog)
            }

            Text(item.original)
                .font(.title2.weight(.semibold))
                .foregroundStyle(UnfiledTheme.paper)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("Original capture: \(item.original)")

            VStack(alignment: .leading, spacing: 12) {
                EditorialEyebrow(text: "Why it stopped")
                Text(item.actionSummary)
                    .font(.body)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
                Label(item.proposedDestination, systemImage: "arrow.turn.down.right")
                    .font(.title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 18)
            .overlay(alignment: .top) { SectionRule() }
            .overlay(alignment: .bottom) { SectionRule() }

            if !item.relatedNotes.isEmpty {
                relatedNotes
            }

            if item.allows(.route) {
                destinationChoices
            }

            if item.type == .pendingExpansion {
                Text("The proposed text has not been added to a note. Dismiss removes only this Review hold.")
                    .font(.footnote)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
            }

            actionControls

            if let errorMessage {
                Label(errorMessage, systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(UnfiledTheme.paper)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("review.error.\(item.id)")
            }

            Label("Original preserved", systemImage: "doc.badge.clock")
                .font(.caption)
                .foregroundStyle(UnfiledTheme.fog)
                .accessibilityLabel("Original capture preserved")
        }
        .padding(.vertical, 26)
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
                                .font(.body.weight(.semibold))
                                .fixedSize(horizontal: false, vertical: true)
                            Text("Revision \(note.revision)")
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(UnfiledTheme.fog)
                        }
                        Spacer(minLength: 8)
                        Image(systemName: "arrow.right")
                            .font(.caption.weight(.bold))
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
        VStack(alignment: .leading, spacing: 10) {
            EditorialEyebrow(text: "Suggested destinations")
            ForEach(item.suggestedDestinations.prefix(3)) { destination in
                Button {
                    onAction(item.id, .route(noteID: destination.id))
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "arrow.turn.down.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(UnfiledTheme.persimmon)
                            .accessibilityHidden(true)
                        Text(destination.title)
                            .font(.body.weight(.semibold))
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 8)
                    }
                    .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                    .padding(.horizontal, 14)
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
                    .font(.body.weight(.semibold))
                    .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            }
            .buttonStyle(.plain)
            .foregroundStyle(UnfiledTheme.persimmon)
            .disabled(allActionsDisabled)
            .accessibilityIdentifier(ReviewAccessibilityIdentifier.chooseNote(item.id))
        }
    }

    private var actionControls: some View {
        VStack(alignment: .leading, spacing: 10) {
            if isSubmitting {
                Label("Saving your choice", systemImage: "clock")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(UnfiledTheme.fog)
                    .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                    .accessibilityIdentifier("review.submitting.\(item.id)")
            }

            if item.allows(.create) {
                reviewButton(
                    title: item.suggestedNewNote.map { "New note: \($0.title)" } ?? "New note",
                    systemImage: "plus",
                    prominence: .primary,
                    identifier: ReviewAccessibilityIdentifier.newNote(item.id)
                ) { onAction(item.id, .createNote) }
            }

            if item.allows(.keepInbox) {
                reviewButton(
                    title: "Keep in Inbox",
                    systemImage: "tray",
                    prominence: .secondary,
                    identifier: ReviewAccessibilityIdentifier.keepInbox(item.id)
                ) { onAction(item.id, .keepInbox) }
            }

            if item.allows(.keepBoth) {
                reviewButton(
                    title: "Keep both notes",
                    systemImage: "doc.on.doc",
                    prominence: .primary,
                    identifier: ReviewAccessibilityIdentifier.keepBoth(item.id)
                ) { onAction(item.id, .keepBoth) }
            }

            if item.allows(.dismiss) {
                reviewButton(
                    title: "Dismiss",
                    systemImage: "xmark",
                    prominence: .secondary,
                    identifier: ReviewAccessibilityIdentifier.dismiss(item.id)
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
        action: @escaping @MainActor () -> Void
    ) -> some View {
        Button(action: action) {
            Label(title, systemImage: systemImage)
                .font(.body.weight(.semibold))
                .frame(maxWidth: .infinity, minHeight: 52)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(prominence == .primary ? UnfiledTheme.ink : UnfiledTheme.paper)
        .background(prominence == .primary ? UnfiledTheme.persimmon : UnfiledTheme.graphite)
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .disabled(allActionsDisabled)
        .opacity(allActionsDisabled && !isSubmitting ? 0.5 : 1)
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
                Text("Loading review queue").font(.headline)
                Text("Checking for captures that need your decision.")
                    .font(.body)
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
            Label("Review queue is unavailable", systemImage: "exclamationmark.circle")
                .font(.headline)
            Text(message)
                .font(.body)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                Task { await onRetry() }
            } label: {
                Text("Try again")
                    .font(.body.weight(.semibold))
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            }
            .accessibilityIdentifier("review.retry")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 24)
        .accessibilityIdentifier("review.error")
    }
}
