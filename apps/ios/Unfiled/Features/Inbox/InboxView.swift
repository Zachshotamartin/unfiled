import SwiftUI

/// The Inbox: where thoughts land. A capture card first, then only what needs a decision. Filed
/// captures are notes in the Library and never show here.
struct InboxView: View {
    let receipts: [ReceiptPresentation]
    let reviewItems: [ReviewPresentation]
    let isLoading: Bool
    let needsProviderKey: Bool
    let submittingInteractionIDs: Set<String>
    let interactionErrors: [String: String]
    let onRefresh: @MainActor () async -> Void
    let onOpenSettings: @MainActor () -> Void
    let onOpenCapture: @MainActor (String) -> Void
    let onOpenNote: @MainActor (String) -> Void
    let onMove: @MainActor (String, String, String) -> Void
    let onUndo: @MainActor (String, String, Int) -> Void
    let onShowReview: @MainActor (String) -> Void
    let onRetryCapture: @MainActor (String) -> Void
    let onEditCapture: @MainActor (String) -> Void
    let onOrganizeAgain: @MainActor (String, String?) -> Void
    let onDeleteCapture: @MainActor (String) -> Void
    let onCapture: @MainActor () -> Void
    let onReviewAction: @MainActor (String, ReviewUserAction) -> Void

    /// Captures that need the owner and are not already an open review card.
    private var waiting: [ReceiptPresentation] {
        InboxAttention.rows(receipts, openReviewIDs: Set(reviewItems.map(\.id)))
    }

    private var waitingCount: Int {
        reviewItems.count + waiting.count + (needsProviderKey ? 1 : 0)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header
                    .padding(.bottom, UnfiledTheme.sectionTop)
                CaptureCard(action: onCapture)
                sectionLabel("Needs you", showsSpinner: false)
                    .padding(.top, UnfiledTheme.sectionTop)
                    .padding(.bottom, UnfiledTheme.labelToRule)
                if waitingCount == 0 {
                    HStack(alignment: .center, spacing: 10) {
                        if isLoading {
                            UnfiledLoadingView(size: 18, label: "Checking what needs you")
                        }
                        Text(InboxAttention.emptyCopy(isLoading: isLoading))
                            .font(UnfiledType.secondary)
                            .foregroundStyle(UnfiledTheme.fog)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityIdentifier(isLoading ? "inbox.checking" : "inbox.nothing-waiting")
                } else {
                    VStack(spacing: UnfiledTheme.controlGap) {
                        if needsProviderKey {
                            KeyCard(action: onOpenSettings)
                        }
                        ForEach(Array(reviewItems.enumerated()), id: \.element.id) { index, item in
                            DeskCard {
                                ReviewLedgerRow(
                                    item: item,
                                    position: index + 1,
                                    total: reviewItems.count,
                                    isSubmitting: submittingInteractionIDs.contains("review.\(item.id)"),
                                    errorMessage: interactionErrors["review.\(item.id)"],
                                    actionsDisabled: isLoading,
                                    onOpenRelatedNote: onOpenNote,
                                    onAction: onReviewAction
                                )
                            }
                        }
                        ForEach(waiting) { receipt in
                            DeskCard {
                                receiptRow(receipt, inCard: true, retryAvailable: !needsProviderKey)
                                if needsProviderKey {
                                    Text("Add a key above and this will organize on the next try.")
                                        .font(UnfiledType.caption)
                                        .foregroundStyle(UnfiledTheme.fog)
                                        .padding(.top, 6)
                                }
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, UnfiledTheme.screenBottom)
            .animation(UnfiledMotion.animation(UnfiledMotion.settle), value: receipts.map(\.id))
            .animation(UnfiledMotion.animation(UnfiledMotion.settle), value: reviewItems.map(\.id))
        }
        .refreshable { await onRefresh() }
        .unfiledScreen()
    }

    private var header: some View {
        ScreenHeader(title: "Inbox", subtitle: summary) {
            IconButton(glyph: .sliders, label: "Settings", action: onOpenSettings)
        }
    }

    private var summary: String {
        InboxAttention.summary(waitingCount: waitingCount, isLoading: isLoading)
    }

    private func sectionLabel(_ text: String, showsSpinner: Bool) -> some View {
        HStack(alignment: .center) {
            EditorialEyebrow(text: text)
            Spacer()
            if showsSpinner {
                UnfiledLoadingView(size: 18, label: "Refreshing")
            }
        }
    }

    private func receiptRow(
        _ receipt: ReceiptPresentation,
        inCard: Bool = false,
        retryAvailable: Bool = true
    ) -> some View {
        ReceiptLedgerRow(
            receipt: receipt,
            inCard: inCard,
            retryAvailable: retryAvailable,
            reviewOpen: receipt.reviewItemID.map { id in reviewItems.contains { $0.id == id } } ?? false,
            actionsDisabled: isLoading,
            submittingInteractionIDs: submittingInteractionIDs,
            interactionErrors: interactionErrors,
            onOpenCapture: onOpenCapture,
            onOpenNote: onOpenNote,
            onMove: onMove,
            onUndo: onUndo,
            onShowReview: onShowReview,
            onRetryCapture: onRetryCapture,
            onEditCapture: onEditCapture,
            onOrganizeAgain: onOrganizeAgain,
            onDeleteCapture: onDeleteCapture
        )
    }
}

/// A white card on the paper ground: the container for anything the owner acts on.
struct DeskCard<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            content()
        }
        .padding(UnfiledTheme.cardPadding)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(UnfiledTheme.graphite)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .stroke(UnfiledTheme.border, lineWidth: 1)
        }
    }
}

/// The first thing on the Inbox: an invitation to write, which opens the composer.
private struct CaptureCard: View {
    let action: @MainActor () -> Void

    var body: some View {
        Button(action: action) {
            DeskCard {
                HStack(alignment: .center, spacing: UnfiledTheme.controlGap) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("What's on your mind?")
                            .font(UnfiledType.title)
                            .foregroundStyle(UnfiledTheme.paper)
                        Text("Write it down. Unfiled files it.")
                            .font(UnfiledType.secondary)
                            .foregroundStyle(UnfiledTheme.fog)
                    }
                    Spacer(minLength: 8)
                    GlyphView(glyph: .pen, size: 22, weight: 2.1)
                        .foregroundStyle(UnfiledTheme.ink)
                        .frame(width: UnfiledTheme.minimumTouchTarget, height: UnfiledTheme.minimumTouchTarget)
                        .background(UnfiledTheme.persimmon)
                        .clipShape(Circle())
                }
            }
        }
        .buttonStyle(.unfiledPress)
        .accessibilityLabel("Write something")
        .accessibilityIdentifier("inbox.capture-card")
    }
}

/// Shown until the owner saves a provider key, because nothing can be organized without one.
private struct KeyCard: View {
    let action: @MainActor () -> Void

    var body: some View {
        DeskCard {
            VStack(alignment: .leading, spacing: 8) {
                HStack(alignment: .center, spacing: 8) {
                    StatusDot(color: UnfiledTheme.persimmon)
                    Text("Add your AI key")
                        .font(UnfiledType.heading)
                }
                Text("Organizing needs your own OpenAI or Claude key. Add one in Settings and new captures file themselves.")
                    .font(UnfiledType.secondary)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
                Button("Open Settings", action: action)
                    .font(UnfiledType.heading)
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            }
        }
        .accessibilityIdentifier("inbox.key-card")
    }
}

private struct ReceiptLedgerRow: View {
    let receipt: ReceiptPresentation
    /// Inside a card the card supplies the padding; in a list the row does.
    var inCard = false
    /// Retry is offered only when a retry can succeed (a provider key exists).
    var retryAvailable = true
    /// Open Review is offered only while the receipt's review item is still open.
    var reviewOpen = false
    let actionsDisabled: Bool
    let submittingInteractionIDs: Set<String>
    let interactionErrors: [String: String]
    let onOpenCapture: @MainActor (String) -> Void
    let onOpenNote: @MainActor (String) -> Void
    let onMove: @MainActor (String, String, String) -> Void
    let onUndo: @MainActor (String, String, Int) -> Void
    let onShowReview: @MainActor (String) -> Void
    let onRetryCapture: @MainActor (String) -> Void
    let onEditCapture: @MainActor (String) -> Void
    let onOrganizeAgain: @MainActor (String, String?) -> Void
    let onDeleteCapture: @MainActor (String) -> Void
    @State private var directions = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack(alignment: .center, spacing: 9) {
                StatusDot(color: UnfiledTheme.persimmon)
                Text(receipt.category)
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
                Spacer(minLength: 10)
                Text(receipt.time)
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
            }

            Button {
                onOpenCapture(receipt.id)
            } label: {
                HStack(alignment: .center, spacing: 12) {
                    Text(receipt.original)
                        .font(UnfiledType.thought)
                        .foregroundStyle(UnfiledTheme.paper)
                        .multilineTextAlignment(.leading)
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    GlyphView(glyph: .chevron, size: 16, weight: 1.8)
                        .foregroundStyle(UnfiledTheme.fog)
                }
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.minimumTouchTarget,
                       alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.unfiledPress)
            .accessibilityLabel("\(receipt.headline). Open receipt details")
            .accessibilityIdentifier(ReceiptAccessibilityIdentifier.detail(receipt.id))

            if !receipt.attachments.isEmpty {
                AttachmentThumbnailRow(attachments: receipt.attachments)
            }

            Text(receipt.headline)
                .font(UnfiledType.secondary)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)

            if !receipt.insertedContent.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(receipt.insertedContent.prefix(3))) { item in
                        ReceiptInsertedContentRow(item: item)
                    }
                    if receipt.insertedContent.count > 3 {
                        Text("\(receipt.insertedContent.count - 3) more in receipt details")
                            .font(UnfiledType.caption)
                            .foregroundStyle(UnfiledTheme.fog)
                    }
                }
                .padding(.top, 2)
            }

            if receipt.pending {
                Label { Text("Saved safely; waiting to finish") } icon: { GlyphView(glyph: .clock, size: 14, weight: 1.6) }
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if !receipt.actions.isEmpty {
                ReceiptActionButtons(
                    receipt: receipt,
                    actionsDisabled: actionsDisabled,
                    submittingInteractionIDs: submittingInteractionIDs,
                    onOpenNote: onOpenNote,
                    onMove: onMove,
                    onUndo: onUndo
                )
            }

            if !receipt.reasons.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(receipt.reasons, id: \.self) { reason in
                        GlyphLabel(reason, glyph: .info, size: 14, weight: 1.8)
                            .font(UnfiledType.secondary)
                            .foregroundStyle(UnfiledTheme.fog)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .accessibilityIdentifier("receipt.reasons.\(receipt.id)")
            }

            if let reviewItemID = receipt.reviewItemID {
                if reviewOpen {
                    Button {
                        onShowReview(reviewItemID)
                    } label: {
                        Label { Text("Open Review") } icon: { GlyphView(glyph: .tray, size: 16, weight: 1.8) }
                            .font(UnfiledType.heading)
                            .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                    }
                    .buttonStyle(.plain)
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .accessibilityIdentifier(ReceiptAccessibilityIdentifier.review(receipt.id))
                } else {
                    Text("This review was closed without filing.")
                        .font(UnfiledType.caption)
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier(ReceiptAccessibilityIdentifier.review(receipt.id))
                }
            }

            if receipt.canOrganizeAgain && retryAvailable {
                OrganizeAgainField(
                    directions: $directions,
                    identifier: "receipt.directions.\(receipt.id)",
                    onSubmit: { onOrganizeAgain(receipt.id, directions) }
                )
            }

            if receipt.canEditText {
                Button {
                    onEditCapture(receipt.id)
                } label: {
                    Label { Text("Edit text") } icon: { GlyphView(glyph: .pen, size: 16, weight: 1.8) }
                        .font(UnfiledType.heading)
                        .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                }
                .buttonStyle(.plain)
                .foregroundStyle(UnfiledTheme.persimmon)
                .accessibilityIdentifier("receipt.edit.\(receipt.id)")
            }

            if receipt.retryable && retryAvailable {
                Button {
                    UnfiledHaptics.tap()
                    onRetryCapture(receipt.id)
                } label: {
                    Label { Text("Retry") } icon: { GlyphView(glyph: .send, size: 14, weight: 1.8) }
                        .font(UnfiledType.heading)
                        .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                }
                .buttonStyle(.plain)
                .foregroundStyle(UnfiledTheme.persimmon)
                .accessibilityIdentifier("capture.retry.\(receipt.id)")
            }

            if !receipt.pending {
                Button {
                    UnfiledHaptics.warning()
                    onDeleteCapture(receipt.id)
                } label: {
                    Label { Text("Delete capture") } icon: { GlyphView(glyph: .trash, size: 14, weight: 1.8) }
                        .font(UnfiledType.heading)
                        .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                }
                .buttonStyle(.plain)
                .foregroundStyle(UnfiledTheme.fog)
                .accessibilityIdentifier("capture.delete.\(receipt.id)")
            }

            if let interactionError {
                Label { Text(interactionError) } icon: { GlyphView(glyph: .warning, size: 14, weight: 1.6) }
                    .font(UnfiledType.secondary)
                    .foregroundStyle(UnfiledTheme.paper)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, inCard ? 0 : UnfiledTheme.rowVertical)
        .accessibilityIdentifier("receipt.row.\(receipt.id)")
    }

    private var interactionError: String? {
        for action in receipt.actions {
            switch action {
            case .open:
                continue
            case let .move(_, decisionID):
                if let error = interactionErrors["correction.\(decisionID)"] { return error }
            case .undo:
                if let error = interactionErrors["receipt.undo.\(receipt.id)"] { return error }
            }
        }
        return nil
    }

}

/// A line for the owner's directions and the button that organizes the capture again with them.
struct OrganizeAgainField: View {
    @Binding var directions: String
    let identifier: String
    let onSubmit: @MainActor () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            TextField("Tell Unfiled what to do (optional)", text: $directions, axis: .vertical)
                .font(UnfiledType.body)
                .lineLimit(1 ... 4)
                .padding(.horizontal, 14)
                .padding(.vertical, 11)
                .background(UnfiledTheme.graphite)
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius, style: .continuous))
                .overlay {
                    RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius, style: .continuous)
                        .stroke(UnfiledTheme.border, lineWidth: 1)
                }
                .accessibilityIdentifier(identifier)
            Button {
                UnfiledHaptics.tap()
                onSubmit()
            } label: {
                Label { Text("Organize again") } icon: { GlyphView(glyph: .organize, size: 16, weight: 1.9) }
                    .font(UnfiledType.heading)
                    .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
            }
            .buttonStyle(.unfiledPress)
            .foregroundStyle(UnfiledTheme.ink)
            .background(UnfiledTheme.persimmon)
            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            .accessibilityHint("Files this capture again, following your directions if you gave any")
            .accessibilityIdentifier("\(identifier).submit")
        }
    }
}
