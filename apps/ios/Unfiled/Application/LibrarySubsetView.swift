import SwiftUI

struct LibrarySubsetView: View {
    let title: String
    let eyebrow: String
    let notes: [NotePresentation]
    let isDeleted: Bool
    let onRefresh: @MainActor () async -> Void
    let onOpen: @MainActor (String) -> Void
    let onRestore: @MainActor (String) async throws -> Void

    @State private var busyNoteID: String?
    @State private var errorMessage: String?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                EditorialEyebrow(text: eyebrow)
                    .padding(.top, 16)
                Text(title)
                    .font(.system(size: 42, weight: .bold))
                    .tracking(-1.5)
                    .padding(.top, 8)
                    .padding(.bottom, 24)
                SectionRule()

                if notes.isEmpty {
                    EmptyLedgerView(
                        title: isDeleted ? "Nothing waiting for recovery" : "The archive is empty",
                        message: isDeleted
                            ? "Deleted notes appear here during the recovery window."
                            : "Archived notes stay searchable and can be restored at any time."
                    )
                } else {
                    ForEach(notes) { note in
                        HStack(spacing: 14) {
                            Button {
                                if !isDeleted { onOpen(note.id) }
                            } label: {
                                VStack(alignment: .leading, spacing: 7) {
                                    Text(note.title)
                                        .font(.system(size: 20, weight: .semibold))
                                        .foregroundStyle(UnfiledTheme.paper)
                                        .lineLimit(2)
                                    Text("\(note.type.uppercased()) · \(note.updatedLabel)")
                                        .font(.system(size: 11, design: .monospaced))
                                        .foregroundStyle(UnfiledTheme.fog)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                            .disabled(isDeleted)

                            Button {
                                restore(note.id)
                            } label: {
                                if busyNoteID == note.id {
                                    ProgressView().tint(UnfiledTheme.persimmon)
                                } else {
                                    Text("Restore")
                                }
                            }
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundStyle(UnfiledTheme.persimmon)
                            .frame(minWidth: 68, minHeight: 44)
                            .disabled(busyNoteID != nil)
                        }
                        .padding(.vertical, 18)
                        SectionRule()
                    }
                }

                if let errorMessage {
                    Text(errorMessage)
                        .font(.footnote)
                        .foregroundStyle(UnfiledTheme.persimmon)
                        .padding(.vertical, 18)
                }
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
        }
        .refreshable { await onRefresh() }
        .navigationBarTitleDisplayMode(.inline)
        .unfiledScreen()
    }

    private func restore(_ noteID: String) {
        busyNoteID = noteID
        errorMessage = nil
        Task { @MainActor in
            do {
                try await onRestore(noteID)
            } catch {
                errorMessage = "That note could not be restored. Refresh and try again."
            }
            busyNoteID = nil
        }
    }
}
