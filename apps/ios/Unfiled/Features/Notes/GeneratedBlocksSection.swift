import SwiftUI

enum GeneratedBlockAccessibilityIdentifier {
    static let section = "noteDetail.generatedBlocks"
    static let loadMore = "noteDetail.generatedBlocks.loadMore"
    static let paginationNotice = "noteDetail.generatedBlocks.paginationNotice"
    static func block(_ blockID: String) -> String { "noteDetail.generatedBlock.\(blockID)" }
    static func accept(_ blockID: String) -> String {
        "noteDetail.generatedBlock.accept.\(blockID)"
    }
    static func reject(_ blockID: String) -> String {
        "noteDetail.generatedBlock.reject.\(blockID)"
    }
}

enum GeneratedBlockLoadMorePresentation {
    static func buttonTitle(loadError: String?) -> String {
        loadError?.isEmpty == false ? "Try loading more again" : "Load more"
    }

    static func accessibilityLabel(isLoading: Bool, loadError: String?) -> String {
        if isLoading { return "Loading more AI-generated additions" }
        return buttonTitle(loadError: loadError)
    }
}

enum GeneratedBlockVisibility {
    static func visible(_ blocks: [GeneratedBlockPresentation]) -> [GeneratedBlockPresentation] {
        blocks.filter(\.isVisibleInNote)
    }
}

struct GeneratedBlocksSection: View {
    let blocks: [GeneratedBlockPresentation]
    let isLoading: Bool
    let loadError: String?
    let hasMore: Bool
    let isLoadingMore: Bool
    let loadMoreError: String?
    let paginationNotice: String?
    let submittingInteractionIDs: Set<String>
    let interactionErrors: [String: String]
    let onRefresh: @MainActor () async -> Void
    let onLoadMore: @MainActor () async -> Void
    let onResolve: @MainActor (String, GeneratedBlockResolution) -> Void

    @AccessibilityFocusState private var focusedBlockID: String?

    private var visibleBlocks: [GeneratedBlockPresentation] {
        GeneratedBlockVisibility.visible(blocks)
    }

    var body: some View {
        if !visibleBlocks.isEmpty || isLoading || loadError != nil || hasMore ||
            isLoadingMore || loadMoreError != nil || paginationNotice != nil {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .center, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        Text("Generated additions")
                            .font(UnfiledType.title)
                            .accessibilityAddTraits(.isHeader)
                        Text("Shown separately from your note text")
                            .font(UnfiledType.caption)
                            .foregroundStyle(UnfiledTheme.fog)
                    }
                    Spacer(minLength: 12)
                    if isLoading {
                        ProgressView()
                            .controlSize(.small)
                            .tint(UnfiledTheme.persimmon)
                            .accessibilityLabel("Loading AI-generated additions")
                    }
                }

                ForEach(visibleBlocks) { block in
                    blockRow(block)
                        .accessibilityFocused($focusedBlockID, equals: block.id)
                }

                loadMoreControls

                if let paginationNotice, !paginationNotice.isEmpty {
                    Label(paginationNotice, systemImage: "info.circle")
                        .font(UnfiledType.secondary)
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)
                        .accessibilityIdentifier(
                            GeneratedBlockAccessibilityIdentifier.paginationNotice
                        )
                }

                if let loadError, !loadError.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Label(loadError, systemImage: "exclamationmark.circle")
                            .font(UnfiledType.secondary)
                            .foregroundStyle(UnfiledTheme.fog)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Try again") { Task { await onRefresh() } }
                            .font(UnfiledType.heading)
                            .foregroundStyle(UnfiledTheme.persimmon)
                            .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                            .accessibilityIdentifier("noteDetail.generatedBlocks.retry")
                    }
                }
            }
            .padding(.vertical, UnfiledTheme.rowVertical)
            .accessibilityIdentifier(GeneratedBlockAccessibilityIdentifier.section)
            .onChange(of: visibleBlocks.map(\.id)) { previous, current in
                if let focusedBlockID,
                   previous.contains(focusedBlockID),
                   !current.contains(focusedBlockID) {
                    self.focusedBlockID = current.first
                }
            }
        }
    }

    @ViewBuilder
    private var loadMoreControls: some View {
        if isLoadingMore {
            Label("Loading more additions", systemImage: "clock")
                .font(UnfiledType.caption)
                .foregroundStyle(UnfiledTheme.fog)
                .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                .accessibilityLabel(
                    GeneratedBlockLoadMorePresentation.accessibilityLabel(
                        isLoading: true,
                        loadError: loadMoreError
                    )
                )
                .accessibilityIdentifier(GeneratedBlockAccessibilityIdentifier.loadMore)
        } else if !isLoading && (hasMore || loadMoreError?.isEmpty == false) {
            VStack(alignment: .leading, spacing: 8) {
                if let loadMoreError, !loadMoreError.isEmpty {
                    Label(loadMoreError, systemImage: "exclamationmark.circle")
                        .font(UnfiledType.secondary)
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)
                }
                Button {
                    Task { await onLoadMore() }
                } label: {
                    Label(
                        GeneratedBlockLoadMorePresentation.buttonTitle(
                            loadError: loadMoreError
                        ),
                        systemImage: "arrow.down"
                    )
                    .font(UnfiledType.heading)
                    .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .foregroundStyle(UnfiledTheme.paper)
                .background(UnfiledTheme.ink)
                .overlay {
                    RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                        .stroke(UnfiledTheme.fog.opacity(0.55), lineWidth: 1)
                }
                .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                .accessibilityLabel(
                    GeneratedBlockLoadMorePresentation.accessibilityLabel(
                        isLoading: false,
                        loadError: loadMoreError
                    )
                )
                .accessibilityHint("Shows the next 50 AI-generated additions")
                .accessibilityIdentifier(GeneratedBlockAccessibilityIdentifier.loadMore)
            }
        }
    }

    private func blockRow(_ block: GeneratedBlockPresentation) -> some View {
        let isSubmitting = submittingInteractionIDs.contains(block.operationID)
        let errorMessage = interactionErrors[block.operationID]

        return VStack(alignment: .leading, spacing: 14) {
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

            Text("Model \(block.modelID) · Prompt \(block.promptVersion)")
                .font(UnfiledType.caption)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)

            if block.isActionable {
                if isSubmitting {
                    Label("Saving your decision", systemImage: "clock")
                        .font(UnfiledType.caption)
                        .foregroundStyle(UnfiledTheme.fog)
                        .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                }
                actionButtons(for: block, disabled: isSubmitting)
            } else {
                Label(
                    "Accepted as a separate generated addition",
                    systemImage: "checkmark.circle"
                )
                .font(UnfiledType.caption)
                .foregroundStyle(UnfiledTheme.fog)
            }

            if let errorMessage, !errorMessage.isEmpty {
                Label(errorMessage, systemImage: "exclamationmark.circle")
                    .font(UnfiledType.secondary)
                    .foregroundStyle(UnfiledTheme.paper)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(UnfiledTheme.cardPadding)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(UnfiledTheme.persimmon)
                .frame(width: 3)
        }
        .background(UnfiledTheme.graphite)
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(
            "AI-generated \(block.kindLabel.lowercased()), \(block.stateLabel.lowercased())"
        )
        .accessibilityIdentifier(GeneratedBlockAccessibilityIdentifier.block(block.id))
    }

    private func actionButtons(
        for block: GeneratedBlockPresentation,
        disabled: Bool
    ) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: UnfiledTheme.controlGap) {
                acceptButton(block, disabled: disabled)
                rejectButton(block, disabled: disabled)
            }
            VStack(spacing: UnfiledTheme.controlGap) {
                acceptButton(block, disabled: disabled)
                rejectButton(block, disabled: disabled)
            }
        }
    }

    private func acceptButton(
        _ block: GeneratedBlockPresentation,
        disabled: Bool
    ) -> some View {
        Button {
            onResolve(block.id, .accept)
        } label: {
            Label("Accept", systemImage: "checkmark")
                .font(UnfiledType.heading)
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(UnfiledTheme.ink)
        .background(UnfiledTheme.persimmon)
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .disabled(disabled)
        .accessibilityLabel("Accept AI-generated \(block.kindLabel.lowercased())")
        .accessibilityHint("Keeps it as a separate generated addition without rewriting note text")
        .accessibilityIdentifier(GeneratedBlockAccessibilityIdentifier.accept(block.id))
    }

    private func rejectButton(
        _ block: GeneratedBlockPresentation,
        disabled: Bool
    ) -> some View {
        Button {
            onResolve(block.id, .reject)
        } label: {
            Label("Reject", systemImage: "xmark")
                .font(UnfiledType.heading)
                .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(UnfiledTheme.paper)
        .background(UnfiledTheme.ink)
        .overlay {
            RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                .stroke(UnfiledTheme.fog.opacity(0.55), lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
        .disabled(disabled)
        .accessibilityLabel("Reject AI-generated \(block.kindLabel.lowercased())")
        .accessibilityHint("Removes the proposal from this view without changing note text")
        .accessibilityIdentifier(GeneratedBlockAccessibilityIdentifier.reject(block.id))
    }
}
