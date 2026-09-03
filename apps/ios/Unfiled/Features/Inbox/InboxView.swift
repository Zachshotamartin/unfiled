import SwiftUI

/// The Inbox: where thoughts land. A capture card first, then whatever needs a decision, then
/// the record of what was filed. Cards are for acting; rows are for reading.
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
    let onCapture: @MainActor () -> Void
    let onReviewAction: @MainActor (String, ReviewUserAction) -> Void

    /// Captures whose organization failed wait for the owner's decision.
    private var waiting: [ReceiptPresentation] {
        receipts.filter { $0.retryable && !$0.pending }
    }

    private var filed: [ReceiptPresentation] {
        receipts.filter { !($0.retryable && !$0.pending) }
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
                    Text("Nothing waiting.")
                        .font(UnfiledType.secondary)
                        .foregroundStyle(UnfiledTheme.fog)
                        .accessibilityIdentifier("inbox.nothing-waiting")
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
                sectionLabel("Filed", showsSpinner: isLoading)
                    .padding(.top, UnfiledTheme.sectionTop)
                    .padding(.bottom, UnfiledTheme.labelToRule)
                SectionRule()
                if filed.isEmpty && !isLoading {
                    EmptyLedgerView(
                        title: "Nothing filed yet",
                        message: "Write one thought. It lands here after it is safely saved.",
                        actionTitle: "Write something",
                        action: onCapture
                    )
                } else {
                    ForEach(filed) { receipt in
                        VStack(alignment: .leading, spacing: 0) {
                            receiptRow(receipt)
                            SectionRule()
                        }
                        .transition(UnfiledMotion.row)
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
        let waitingLabel = waitingCount == 1 ? "1 waiting" : "\(waitingCount) waiting"
        let filedLabel = filed.count == 1 ? "1 filed" : "\(filed.count) filed"
        return "\(waitingLabel)  ·  \(filedLabel)"
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
            onEditCapture: onEditCapture
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
                    Text("Review dismissed. The capture stays in your Inbox.")
                        .font(UnfiledType.caption)
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier(ReceiptAccessibilityIdentifier.review(receipt.id))
                }
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
