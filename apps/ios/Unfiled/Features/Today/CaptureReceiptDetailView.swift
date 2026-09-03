import SwiftUI

enum ReceiptAccessibilityIdentifier {
    static func detail(_ captureID: String) -> String { "receipt.detail.\(captureID)" }
    static func open(_ captureID: String) -> String { "receipt.open.\(captureID)" }
    static func move(_ captureID: String) -> String { "receipt.move.\(captureID)" }
    static func undo(_ captureID: String) -> String { "receipt.undo.\(captureID)" }
    static func review(_ captureID: String) -> String { "receipt.review.\(captureID)" }
}

struct CaptureReceiptDetailView: View {
    let receipt: ReceiptPresentation?
    let isLoading: Bool
    let errorMessage: String?
    let submittingInteractionIDs: Set<String>
    let interactionErrors: [String: String]
    let onRefresh: @MainActor () async -> Void
    let onOpenNote: @MainActor (String) -> Void
    let onMove: @MainActor (String, String, String) -> Void
    let onUndo: @MainActor (String, String, Int) -> Void
    let onShowReview: @MainActor (String) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                EditorialEyebrow(text: "Capture receipt")

                if let receipt {
                    receiptContent(receipt)
                } else if isLoading {
                    loadingView
                } else {
                    unavailableView
                }
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.top, UnfiledTheme.pushedHeaderTop)
            .padding(.bottom, UnfiledTheme.pushedScreenBottom)
        }
        .refreshable { await onRefresh() }
        .navigationTitle("Receipt")
        .navigationBarTitleDisplayMode(.inline)
        .unfiledScreen()
    }

    @ViewBuilder
    private func receiptContent(_ receipt: ReceiptPresentation) -> some View {
        Text(receipt.headline)
            .font(UnfiledType.display)
            .tracking(-0.9)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
            .padding(.top, UnfiledTheme.eyebrowToTitle)

        Label(receipt.category, systemImage: statusIcon(receipt))
            .font(UnfiledType.label)
            .textCase(.uppercase)
            .foregroundStyle(UnfiledTheme.fog)
            .padding(.top, 14)

        SectionRule()
            .padding(.top, UnfiledTheme.headerBottom)

        receiptSection(title: "Original capture") {
            Text(receipt.original)
                .font(UnfiledType.body)
                .foregroundStyle(UnfiledTheme.paper)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)
        }

        if let destinationTitle = receipt.destinationTitle {
            SectionRule()
            receiptSection(title: "Destination") {
                Label(destinationTitle, systemImage: "arrow.turn.down.right")
                    .font(UnfiledType.title)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }

        if !receipt.insertedContent.isEmpty {
            SectionRule()
            receiptSection(title: "Inserted content") {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(receipt.insertedContent) { item in
                        ReceiptInsertedContentRow(item: item)
                    }
                }
            }
        }

        if receipt.pending {
            SectionRule()
            Label("Saved safely; organization is still in progress", systemImage: "clock")
                .font(UnfiledType.body)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.vertical, UnfiledTheme.rowVertical)
        }

        if !receipt.actions.isEmpty {
            SectionRule()
                .padding(.bottom, 18)
            ReceiptActionButtons(
                receipt: receipt,
                actionsDisabled: isLoading,
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
                Label { Text("Open Review") } icon: { GlyphView(glyph: .tray, size: 16, weight: 1.8) }
                    .font(UnfiledType.heading)
                    .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
            }
            .buttonStyle(.plain)
            .foregroundStyle(UnfiledTheme.ink)
            .background(UnfiledTheme.persimmon)
            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
            .accessibilityHint("Opens the decision waiting for you")
            .accessibilityIdentifier(ReceiptAccessibilityIdentifier.review(receipt.id))
            .padding(.top, 18)
        }

        if let interactionError = receiptInteractionError(receipt) {
            Label(interactionError, systemImage: "exclamationmark.circle")
                .font(UnfiledType.secondary)
                .foregroundStyle(UnfiledTheme.paper)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 18)
        }

        if let errorMessage {
            Label(errorMessage, systemImage: "wifi.exclamationmark")
                .font(UnfiledType.secondary)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 18)
        }
    }

    private func receiptSection<Content: View>(
        title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            EditorialEyebrow(text: title)
            content()
        }
        .padding(.vertical, UnfiledTheme.rowVertical)
    }

    private var loadingView: some View {
        HStack(spacing: 14) {
            ProgressView()
                .tint(UnfiledTheme.persimmon)
            Text("Loading the latest receipt")
                .font(UnfiledType.body)
                .foregroundStyle(UnfiledTheme.fog)
        }
        .frame(maxWidth: .infinity, minHeight: 180, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Loading the latest receipt")
    }

    private var unavailableView: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Receipt unavailable")
                .font(UnfiledType.title)
            Text(errorMessage ?? "The saved capture could not be loaded right now.")
                .font(UnfiledType.body)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                Task { await onRefresh() }
            } label: {
                Text("Try again")
                    .font(UnfiledType.heading)
                    .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            }
            .accessibilityIdentifier("receipt.detail.retry")
        }
        .padding(.top, UnfiledTheme.sectionTop)
    }

    private func receiptInteractionError(_ receipt: ReceiptPresentation) -> String? {
        for action in receipt.actions {
            switch action {
            case .open:
                continue
            case let .move(_, decisionID):
                if let value = interactionErrors["correction.\(decisionID)"] { return value }
            case .undo:
                if let value = interactionErrors["receipt.undo.\(receipt.id)"] { return value }
            }
        }
        return nil
    }

    private func statusIcon(_ receipt: ReceiptPresentation) -> String {
        if receipt.pending { return "clock" }
        switch receipt.outcome {
        case .createdNote, .addedToNote: return "checkmark.circle"
        case .needsReview: return "tray.and.arrow.down"
        case .keptInInbox: return "tray"
        case .failed: return "exclamationmark.circle"
        case nil: return "doc.text"
        }
    }
}

struct ReceiptInsertedContentRow: View {
    let item: ReceiptContentPresentation

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Rectangle()
                .fill(item.kind == .aiGenerated ? UnfiledTheme.persimmon : UnfiledTheme.border)
                .frame(width: 3)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 6) {
                if let provenance = item.provenanceLabel {
                    Text(provenance)
                        .font(UnfiledType.label)
                        .foregroundStyle(UnfiledTheme.persimmon)
                }
                Text(item.content)
                    .font(UnfiledType.body)
                    .foregroundStyle(UnfiledTheme.paper)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            item.kind == .aiGenerated
                ? "AI-generated proposal: \(item.content)"
                : item.content
        )
    }
}

struct ReceiptActionButtons: View {
    let receipt: ReceiptPresentation
    var actionsDisabled = false
    let submittingInteractionIDs: Set<String>
    let onOpenNote: @MainActor (String) -> Void
    let onMove: @MainActor (String, String, String) -> Void
    let onUndo: @MainActor (String, String, Int) -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 18) {
                actionButtons
            }
            VStack(alignment: .leading, spacing: 8) {
                actionButtons
            }
        }
    }

    @ViewBuilder
    private var actionButtons: some View {
        ForEach(receipt.actions) { action in
            switch action {
            case let .open(noteID):
                actionButton(
                    title: "Open",
                    systemImage: "arrow.right",
                    identifier: ReceiptAccessibilityIdentifier.open(receipt.id),
                    isBusy: false,
                    isDisabled: false
                ) { onOpenNote(noteID) }
            case let .move(noteID, decisionID):
                actionButton(
                    title: "Move",
                    systemImage: "arrow.turn.up.right",
                    identifier: ReceiptAccessibilityIdentifier.move(receipt.id),
                    isBusy: submittingInteractionIDs.contains("correction.\(decisionID)"),
                    isDisabled: actionsDisabled || isMutationBusy
                ) { onMove(receipt.id, noteID, decisionID) }
            case let .undo(mutationID, expectedRevision):
                actionButton(
                    title: "Undo",
                    systemImage: "arrow.uturn.backward",
                    identifier: ReceiptAccessibilityIdentifier.undo(receipt.id),
                    isBusy: submittingInteractionIDs.contains("receipt.undo.\(receipt.id)"),
                    isDisabled: actionsDisabled || isMutationBusy
                ) { onUndo(receipt.id, mutationID, expectedRevision) }
            }
        }
    }

    private func actionButton(
        title: String,
        systemImage: String,
        identifier: String,
        isBusy: Bool,
        isDisabled: Bool,
        action: @escaping @MainActor () -> Void
    ) -> some View {
        Button(action: action) {
            HStack(spacing: 7) {
                if isBusy {
                    ProgressView()
                        .controlSize(.small)
                        .tint(UnfiledTheme.persimmon)
                        .accessibilityHidden(true)
                } else {
                    Image(systemName: systemImage)
                        .font(UnfiledType.label)
                        .accessibilityHidden(true)
                }
                Text(isBusy ? "Working…" : title)
                    .font(UnfiledType.heading)
            }
            .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(title == "Open" ? UnfiledTheme.paper : UnfiledTheme.persimmon)
        .disabled(isDisabled)
        .opacity(isDisabled && !isBusy ? 0.5 : 1)
        .accessibilityLabel(isBusy ? "\(title) in progress" : title)
        .accessibilityIdentifier(identifier)
    }

    private var isMutationBusy: Bool {
        receipt.actions.contains { action in
            switch action {
            case .open:
                false
            case let .move(_, decisionID):
                submittingInteractionIDs.contains("correction.\(decisionID)")
            case .undo:
                submittingInteractionIDs.contains("receipt.undo.\(receipt.id)")
            }
        }
    }
}
