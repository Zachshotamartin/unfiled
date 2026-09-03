import SwiftUI

struct RevisionHistoryView: View {
    @State private var selectedRestore: RevisionPresentation?
    @State private var restoringRevisionID: String?
    @State private var feedbackMessage: String?

    let noteTitle: String
    let currentRevision: Int
    let revisions: [RevisionPresentation]
    let isLoading: Bool
    let errorMessage: String?
    let onRefresh: @MainActor () async -> Void
    let onPreviewRevision: @MainActor (String) -> Void
    let onRestoreRevision: @MainActor (String, Int) async throws -> Void

    private var snapshot: RevisionHistorySnapshot {
        RevisionHistorySnapshot(revisions: revisions, currentRevision: currentRevision)
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                header
                SectionRule()

                if isLoading && revisions.isEmpty {
                    loadingRows
                } else if let errorMessage, revisions.isEmpty {
                    errorState(errorMessage)
                } else if snapshot.ordered.isEmpty {
                    EmptyLedgerView(
                        title: "No revisions yet",
                        message: "Saved edits and organized updates will appear here."
                    )
                } else {
                    ForEach(snapshot.ordered) { revision in
                        revisionRow(revision)
                        SectionRule()
                    }
                }

                if let feedbackMessage {
                    Label(feedbackMessage, systemImage: "exclamationmark.circle")
                        .font(UnfiledType.secondaryStrong)
                        .foregroundStyle(UnfiledTheme.persimmon)
                        .padding(.vertical, 18)
                        .accessibilityIdentifier("revisionHistory.feedback")
                }
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, UnfiledTheme.pushedScreenBottom)
        }
        .refreshable { await onRefresh() }
        .confirmationDialog(
            "Restore revision \(selectedRestore?.revision ?? 0)?",
            isPresented: Binding(
                get: { selectedRestore != nil },
                set: { if !$0 { selectedRestore = nil } }
            ),
            titleVisibility: .visible
        ) {
            if let selectedRestore {
                Button("Restore revision") { restore(selectedRestore) }
            }
            Button("Cancel", role: .cancel) { selectedRestore = nil }
        } message: {
            Text("The current note remains in history. Restoring creates a new revision.")
        }
        .unfiledScreen()
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            EditorialEyebrow(text: "Revision history")
            Text(noteTitle)
                .font(UnfiledType.display)
                .tracking(-1.1)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            Text("Every restore creates a new revision. Nothing here is overwritten.")
                .font(UnfiledType.secondary)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, UnfiledTheme.pushedHeaderTop)
        .padding(.bottom, UnfiledTheme.headerBottom)
    }

    private func revisionRow(_ revision: RevisionPresentation) -> some View {
        let isCurrent = revision.revision == currentRevision
        let isRestoring = restoringRevisionID == revision.id

        return VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline) {
                Text("Revision \(revision.revision)")
                    .font(UnfiledType.title)
                if isCurrent {
                    Text("Current")
                        .font(UnfiledType.label)
                        .foregroundStyle(UnfiledTheme.persimmon)
                }
                Spacer(minLength: 12)
                Text(revision.createdLabel)
                    .font(UnfiledType.caption)
                    .foregroundStyle(UnfiledTheme.fog)
            }

            Text(revision.title)
                .font(UnfiledType.body)
                .lineLimit(2)
            Label(sourceLabel(revision.source), systemImage: sourceIcon(revision.source))
                .font(UnfiledType.caption)
                .foregroundStyle(UnfiledTheme.fog)

            HStack(spacing: 18) {
                Button("View") { onPreviewRevision(revision.id) }
                    .font(UnfiledType.secondaryStrong)
                    .foregroundStyle(UnfiledTheme.paper)
                    .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                    .accessibilityIdentifier("revisionHistory.view.\(revision.id)")

                if !isCurrent {
                    Button {
                        selectedRestore = revision
                    } label: {
                        if isRestoring {
                            ProgressView().tint(UnfiledTheme.persimmon)
                        } else {
                            Text("Restore")
                        }
                    }
                    .font(UnfiledType.secondaryStrong)
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .frame(minHeight: UnfiledTheme.minimumTouchTarget)
                    .disabled(restoringRevisionID != nil)
                    .accessibilityLabel("Restore revision \(revision.revision)")
                    .accessibilityIdentifier("revisionHistory.restore.\(revision.id)")
                }
            }
        }
        .padding(.vertical, UnfiledTheme.rowVertical)
        .accessibilityElement(children: .contain)
    }

    private var loadingRows: some View {
        VStack(spacing: 0) {
            ForEach(0..<3, id: \.self) { _ in
                VStack(alignment: .leading, spacing: 12) {
                    RoundedRectangle(cornerRadius: 4)
                        .fill(UnfiledTheme.raised)
                        .frame(width: 140, height: 22)
                    RoundedRectangle(cornerRadius: 4)
                        .fill(UnfiledTheme.graphite)
                        .frame(maxWidth: .infinity)
                        .frame(height: 16)
                }
                .padding(.vertical, UnfiledTheme.rowVertical)
                SectionRule()
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading revision history")
    }

    private func errorState(_ message: String) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Revision history is unavailable")
                .font(UnfiledType.title)
            Text(message)
                .font(UnfiledType.secondary)
                .foregroundStyle(UnfiledTheme.fog)
            Button("Try again") {
                Task { @MainActor in await onRefresh() }
            }
            .font(UnfiledType.secondaryStrong)
            .foregroundStyle(UnfiledTheme.persimmon)
            .frame(minHeight: UnfiledTheme.minimumTouchTarget)
            .accessibilityIdentifier("revisionHistory.retry")
        }
        .padding(.vertical, UnfiledTheme.rowVertical)
    }

    private func restore(_ revision: RevisionPresentation) {
        selectedRestore = nil
        restoringRevisionID = revision.id
        feedbackMessage = nil

        Task { @MainActor in
            do {
                try await onRestoreRevision(revision.id, currentRevision)
                restoringRevisionID = nil
            } catch {
                feedbackMessage = "Revision \(revision.revision) was not restored. Refresh and try again."
                restoringRevisionID = nil
                UIAccessibility.post(notification: .announcement, argument: feedbackMessage)
            }
        }
    }

    private func sourceLabel(_ source: String) -> String {
        switch source {
        case RevisionSource.organization.rawValue: "Organized from a capture"
        case RevisionSource.undo.rawValue: "Undo"
        case RevisionSource.import.rawValue: "Imported"
        case RevisionSource.interactive.rawValue: "Interactive update"
        default: "Manual edit"
        }
    }

    private func sourceIcon(_ source: String) -> String {
        switch source {
        case RevisionSource.organization.rawValue: "tray.and.arrow.down"
        case RevisionSource.undo.rawValue: "arrow.uturn.backward"
        case RevisionSource.import.rawValue: "square.and.arrow.down"
        case RevisionSource.interactive.rawValue: "checklist"
        default: "square.and.pencil"
        }
    }
}

struct RevisionHistorySnapshot: Equatable {
    let ordered: [RevisionPresentation]
    let currentRevision: Int

    init(revisions: [RevisionPresentation], currentRevision: Int) {
        self.currentRevision = currentRevision
        ordered = revisions.sorted {
            if $0.revision == $1.revision { return $0.id < $1.id }
            return $0.revision > $1.revision
        }
    }

    func canRestore(_ revision: RevisionPresentation) -> Bool {
        revision.revision != currentRevision
    }
}
