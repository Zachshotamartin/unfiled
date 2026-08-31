import SwiftUI

struct TodayView: View {
    let receipts: [ReceiptPresentation]
    let isLoading: Bool
    let onRefresh: @MainActor () async -> Void
    let onOpenSettings: @MainActor () -> Void
    let onOpenNote: @MainActor (String) -> Void
    let onUndo: @MainActor (String, Int) -> Void
    let onRetryCapture: @MainActor (String) -> Void
    let onCapture: @MainActor () -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header

                HStack {
                    Text("Recent captures")
                        .font(.system(size: 16))
                        .foregroundStyle(UnfiledTheme.fog)
                    Spacer()
                    if isLoading { ProgressView().tint(UnfiledTheme.persimmon) }
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
                            onOpenNote: onOpenNote,
                            onUndo: onUndo,
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
                        .frame(width: 44, height: 44)
                }
                .accessibilityLabel("Settings")
            }
            Text("Today")
                .font(.system(size: 56, weight: .bold))
                .tracking(-2.2)
            Text(Date.now.formatted(.dateTime.weekday(.wide).month(.wide).day()))
                .font(.system(size: 12, weight: .medium, design: .monospaced))
                .tracking(1.1)
                .foregroundStyle(UnfiledTheme.fog)
                .textCase(.uppercase)
        }
        .padding(.top, 12)
    }
}

private struct ReceiptLedgerRow: View {
    let receipt: ReceiptPresentation
    let onOpenNote: @MainActor (String) -> Void
    let onUndo: @MainActor (String, Int) -> Void
    let onRetryCapture: @MainActor (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 13) {
            HStack {
                Circle()
                    .fill(UnfiledTheme.persimmon)
                    .frame(width: 8, height: 8)
                EditorialEyebrow(text: receipt.category)
                Spacer()
                Text(receipt.time)
                    .font(.system(size: 12, design: .monospaced))
                    .foregroundStyle(UnfiledTheme.fog)
            }

            HStack(alignment: .firstTextBaseline) {
                Text(receipt.headline)
                    .font(.system(size: 21, weight: .semibold))
                    .lineLimit(2)
                Spacer(minLength: 12)
                if let noteID = receipt.destinationNoteID {
                    Button {
                        onOpenNote(noteID)
                    } label: {
                        Label("Open", systemImage: "arrow.right")
                            .labelStyle(.titleAndIcon)
                            .font(.system(size: 14, weight: .medium))
                    }
                    .foregroundStyle(UnfiledTheme.paper)
                    .frame(minHeight: 44)
                }
            }

            Text(receipt.original)
                .font(.system(size: 14, design: .monospaced))
                .foregroundStyle(UnfiledTheme.fog)
                .lineLimit(3)

            HStack {
                if receipt.pending {
                    Label("Saved offline", systemImage: "arrow.triangle.2.circlepath")
                        .font(.system(size: 12, weight: .medium))
                        .foregroundStyle(UnfiledTheme.fog)
                }
                Spacer()
                if let mutationID = receipt.undoMutationID,
                   let expectedRevision = receipt.expectedRevision {
                    Button("Undo") { onUndo(mutationID, expectedRevision) }
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(UnfiledTheme.persimmon)
                        .frame(minHeight: 44)
                }
                if receipt.retryable {
                    Button("Retry") { onRetryCapture(receipt.id) }
                        .font(.system(size: 14, weight: .medium))
                        .foregroundStyle(UnfiledTheme.persimmon)
                        .frame(minHeight: 44)
                        .accessibilityIdentifier("capture.retry.\(receipt.id)")
                }
            }
        }
        .padding(.vertical, 22)
    }
}
