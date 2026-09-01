import SwiftUI

struct TodayView: View {
    let receipts: [ReceiptPresentation]
    let isLoading: Bool
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
    let onCapture: @MainActor () -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header

                HStack {
                    Text("Recent captures")
                        .font(.body)
                        .foregroundStyle(UnfiledTheme.fog)
                    Spacer()
                    if isLoading {
                        ProgressView()
                            .tint(UnfiledTheme.persimmon)
                            .accessibilityLabel("Refreshing recent captures")
                    }
                }
                .padding(.top, 34)
                .padding(.bottom, 14)

                SectionRule()

                if receipts.isEmpty && !isLoading {
                    EmptyLedgerView(
                        title: "Nothing to file yet",
                        message: "Write one thought. It will appear here after it is safely saved.",
                        actionTitle: "Write something",
                        action: onCapture
                    )
                } else {
                    ForEach(receipts) { receipt in
                        ReceiptLedgerRow(
                            receipt: receipt,
                            actionsDisabled: isLoading,
                            submittingInteractionIDs: submittingInteractionIDs,
                            interactionErrors: interactionErrors,
                            onOpenCapture: onOpenCapture,
                            onOpenNote: onOpenNote,
                            onMove: onMove,
                            onUndo: onUndo,
                            onShowReview: onShowReview,
                            onRetryCapture: onRetryCapture
                        )
                        SectionRule()
                    }
                }
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, 110)
        }
        .refreshable { await onRefresh() }
        .unfiledScreen()
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 20) {
            HStack {
                UnfiledMark(size: 32)
                Spacer()
                Button(action: onOpenSettings) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 21))
                        .foregroundStyle(UnfiledTheme.fog)
                        .frame(
                            width: UnfiledTheme.minimumTouchTarget,
                            height: UnfiledTheme.minimumTouchTarget
                        )
                }
                .accessibilityLabel("Settings")
            }
            Text("Today")
                .font(.system(size: 56, weight: .bold))
                .tracking(-2.2)
                .minimumScaleFactor(0.75)
                .accessibilityAddTraits(.isHeader)
            Text(Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()))
                .font(.caption.weight(.medium).monospaced())
                .tracking(1.1)
                .foregroundStyle(UnfiledTheme.fog)
                .textCase(.uppercase)
        }
        .padding(.top, 12)
    }
}

private struct ReceiptLedgerRow: View {
    let receipt: ReceiptPresentation
    let actionsDisabled: Bool
    let submittingInteractionIDs: Set<String>
    let interactionErrors: [String: String]
    let onOpenCapture: @MainActor (String) -> Void
    let onOpenNote: @MainActor (String) -> Void
    let onMove: @MainActor (String, String, String) -> Void
    let onUndo: @MainActor (String, String, Int) -> Void
    let onShowReview: @MainActor (String) -> Void
    let onRetryCapture: @MainActor (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 15) {
            HStack(alignment: .firstTextBaseline, spacing: 9) {
                Image(systemName: statusIcon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .accessibilityHidden(true)
                EditorialEyebrow(text: receipt.category)
                Spacer(minLength: 10)
                Text(receipt.time)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(UnfiledTheme.fog)
            }

            Button {
                onOpenCapture(receipt.id)
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Text(receipt.headline)
                        .font(.title3.weight(.semibold))
                        .foregroundStyle(UnfiledTheme.paper)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.bold))
                        .foregroundStyle(UnfiledTheme.fog)
                        .accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.minimumTouchTarget,
                       alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(receipt.headline). Open receipt details")
            .accessibilityIdentifier(ReceiptAccessibilityIdentifier.detail(receipt.id))

            Text(receipt.original)
                .font(.footnote.monospaced())
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)

            if !receipt.insertedContent.isEmpty {
                VStack(alignment: .leading, spacing: 12) {
                    ForEach(Array(receipt.insertedContent.prefix(3))) { item in
                        ReceiptInsertedContentRow(item: item)
                    }
                    if receipt.insertedContent.count > 3 {
                        Text("\(receipt.insertedContent.count - 3) more in receipt details")
                            .font(.caption.monospaced())
                            .foregroundStyle(UnfiledTheme.fog)
                    }
                }
                .padding(.top, 2)
            }

            if receipt.pending {
                Label("Saved safely; waiting to finish", systemImage: "clock")
                    .font(.caption.weight(.medium))
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
                Button {
                    onShowReview(reviewItemID)
                } label: {
                    Label("Open Review", systemImage: "tray.and.arrow.down")
                        .font(.body.weight(.semibold))
                        .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                }
                .buttonStyle(.plain)
                .foregroundStyle(UnfiledTheme.persimmon)
                .accessibilityIdentifier(ReceiptAccessibilityIdentifier.review(receipt.id))
            }

            if receipt.retryable {
                Button {
                    onRetryCapture(receipt.id)
                } label: {
                    Label("Retry", systemImage: "arrow.clockwise")
                        .font(.body.weight(.semibold))
                        .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                }
                .buttonStyle(.plain)
                .foregroundStyle(UnfiledTheme.persimmon)
                .accessibilityIdentifier("capture.retry.\(receipt.id)")
            }

            if let interactionError {
                Label(interactionError, systemImage: "exclamationmark.circle")
                    .font(.footnote)
                    .foregroundStyle(UnfiledTheme.paper)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 24)
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

    private var statusIcon: String {
        if receipt.pending { return "clock" }
        return switch receipt.outcome {
        case .createdNote, .addedToNote: "checkmark.circle"
        case .needsReview: "tray.and.arrow.down"
        case .keptInInbox: "tray"
        case .failed: "exclamationmark.circle"
        case nil: "doc.text"
        }
    }
}
