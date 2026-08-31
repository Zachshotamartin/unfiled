import SwiftUI

enum ReviewNavigation: Sendable {
    static func identifier(for reviewID: String) -> String {
        "review.openNote.\(reviewID)"
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
    let onRefresh: @MainActor () async -> Void
    let onOpenRelatedNote: @MainActor (String) -> Void

    init(
        items: [ReviewPresentation],
        isLoading: Bool,
        errorMessage: String? = nil,
        onRefresh: @escaping @MainActor () async -> Void = {},
        onOpenRelatedNote: @escaping @MainActor (String) -> Void
    ) {
        self.items = items
        self.isLoading = isLoading
        self.errorMessage = errorMessage
        self.onRefresh = onRefresh
        self.onOpenRelatedNote = onOpenRelatedNote
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
            Text("Inspect captures that need a decision. Native resolution controls are not available in this build.")
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
            if !items.isEmpty {
                SectionRule()
            }
        }

        if items.isEmpty {
            if normalizedError != nil {
                EmptyView()
            } else if isLoading {
                ReviewLoadingLedgerView()
            } else {
                EmptyLedgerView(
                    title: "Everything has a place",
                    message: "Captures that need your decision will wait here."
                )
                .accessibilityIdentifier("review.empty")
            }
        } else {
            ForEach(Array(items.enumerated()), id: \.element.id) { index, item in
                ReviewLedgerRow(
                    item: item,
                    position: index + 1,
                    total: items.count,
                    actionsDisabled: isLoading,
                    onOpenRelatedNote: onOpenRelatedNote
                )
                SectionRule()
            }
        }
    }

    private var normalizedError: String? {
        guard let errorMessage else { return nil }
        let trimmed = errorMessage.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

}

private struct ReviewLedgerRow: View {
    let item: ReviewPresentation
    let position: Int
    let total: Int
    let actionsDisabled: Bool
    let onOpenRelatedNote: @MainActor (String) -> Void

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
                Text("PROPOSED DESTINATION")
                    .font(.caption.weight(.medium).monospaced())
                    .tracking(0.9)
                    .foregroundStyle(UnfiledTheme.fog)

                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Image(systemName: "arrow.turn.down.right")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(UnfiledTheme.persimmon)
                        .accessibilityHidden(true)
                    Text(item.proposedDestination)
                        .font(.title3.weight(.semibold))
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                }
            }
            .padding(.vertical, 18)
            .overlay(alignment: .top) { SectionRule() }
            .overlay(alignment: .bottom) { SectionRule() }

            VStack(alignment: .leading, spacing: 12) {
                Text("ACTION SUMMARY")
                    .font(.caption.weight(.medium).monospaced())
                    .tracking(0.9)
                    .foregroundStyle(UnfiledTheme.fog)

                HStack(alignment: .firstTextBaseline, spacing: 12) {
                    Circle()
                        .fill(UnfiledTheme.persimmon)
                        .frame(width: 9, height: 9)
                        .accessibilityHidden(true)
                    Text(item.actionSummary)
                        .font(.body)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let noteID = item.noteID {
                Button {
                    onOpenRelatedNote(noteID)
                } label: {
                    Text("Open related note")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .contentShape(Rectangle())
                }
                .buttonStyle(ReviewOpenButtonStyle())
                .disabled(actionsDisabled)
                .accessibilityLabel("Open related note")
                .accessibilityHint("Opens the note without resolving this review item")
                .accessibilityIdentifier(ReviewNavigation.identifier(for: item.id))
            } else {
                Text("This item remains in the review queue. Nothing is moved or dismissed from this screen.")
                    .font(.caption)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityIdentifier("review.readOnly.\(item.id)")
            }

            Label("Original preserved", systemImage: "doc.badge.clock")
                .font(.caption)
                .foregroundStyle(UnfiledTheme.fog)
                .accessibilityLabel("Original capture preserved")
        }
        .padding(.vertical, 26)
        .accessibilityIdentifier("review.item.\(item.id)")
    }
}

private struct ReviewOpenButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(UnfiledTheme.ink)
            .background(UnfiledTheme.persimmon)
            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            .opacity(configuration.isPressed ? 0.72 : 1)
    }
}

private struct ReviewLoadingLedgerView: View {
    var body: some View {
        HStack(spacing: 14) {
            ProgressView()
                .tint(UnfiledTheme.persimmon)
            VStack(alignment: .leading, spacing: 4) {
                Text("Loading review queue")
                    .font(.headline)
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
            .accessibilityHint("Reloads the review queue")
            .accessibilityIdentifier("review.retry")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 24)
        .accessibilityIdentifier("review.error")
    }
}
