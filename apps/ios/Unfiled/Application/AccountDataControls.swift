import SwiftUI
import UIKit

enum AccountDataAccessibilityIdentifier {
    static let export = "settings.account.export"
    static let exportError = "settings.account.export.error"
    static let delete = "settings.account.delete"
    static let deleteConfirmation = "settings.account.delete.confirmation"
    static let deleteCommit = "settings.account.delete.commit"
    static let deleteError = "settings.account.delete.error"
    static let receipt = "account.delete.receipt"
}

struct AccountDataControls: View {
    @Environment(\.scenePhase) private var scenePhase

    let exportArtifact: AccountExportArtifact?
    let isPreparingExport: Bool
    let exportError: String?
    let isDeletingAccount: Bool
    let hasPendingDeletionReplay: Bool
    let deletionError: String?
    let onPrepareExport: @MainActor () async -> Void
    let onDiscardExport: @MainActor (AccountExportArtifact) -> Void
    let onDeleteAccount: @MainActor () async -> Bool

    @State private var showsDeletionConfirmation = false
    @State private var confirmation = ""
    @FocusState private var confirmationFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("YOUR DATA")
                .font(.caption.weight(.medium).monospaced())
                .tracking(1)
                .foregroundStyle(UnfiledTheme.fog)
                .accessibilityAddTraits(.isHeader)

            VStack(alignment: .leading, spacing: 8) {
                Label("Private account export", systemImage: "square.and.arrow.up")
                    .font(.body.weight(.semibold))
                Text("Streams a private archive directly into a protected temporary file, then opens the iOS share sheet. Unfiled removes its temporary copy when sharing ends.")
                    .font(.footnote)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)

                Button {
                    Task { await onPrepareExport() }
                } label: {
                    HStack(spacing: 10) {
                        if isPreparingExport {
                            ProgressView().tint(UnfiledTheme.ink)
                        }
                        Text(isPreparingExport ? "Preparing private export…" : "Prepare private export")
                        Spacer(minLength: 8)
                        Image(systemName: "arrow.right").accessibilityHidden(true)
                    }
                    .font(.body.weight(.semibold))
                    .foregroundStyle(UnfiledTheme.ink)
                    .padding(.horizontal, 15)
                    .frame(maxWidth: .infinity, minHeight: 50)
                    .background(isPreparingExport ? UnfiledTheme.fog : UnfiledTheme.persimmon)
                    .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isPreparingExport || isDeletingAccount)
                .accessibilityHint("Downloads without loading the whole archive into memory")
                .accessibilityIdentifier(AccountDataAccessibilityIdentifier.export)

                if let exportError {
                    dataError(exportError, identifier: AccountDataAccessibilityIdentifier.exportError)
                }
            }

            SectionRule()
                .padding(.vertical, 8)

            VStack(alignment: .leading, spacing: 8) {
                Label("Delete account", systemImage: "trash")
                    .font(.body.weight(.semibold))
                Text("Deletes live account data and revokes every session. Encrypted backups expire after 30 days; signing up again starts a new account.")
                    .font(.footnote)
                    .foregroundStyle(UnfiledTheme.fog)
                    .fixedSize(horizontal: false, vertical: true)

                if hasPendingDeletionReplay {
                    Label(
                        "An earlier deletion is awaiting confirmation. Retry uses the same protected recovery key.",
                        systemImage: "arrow.clockwise"
                    )
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .fixedSize(horizontal: false, vertical: true)
                }

                Button(role: .destructive) {
                    confirmation = ""
                    showsDeletionConfirmation = true
                } label: {
                    Text(hasPendingDeletionReplay ? "Confirm pending deletion" : "Delete my account")
                        .font(.body.weight(.semibold))
                        .foregroundStyle(UnfiledTheme.persimmon)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(UnfiledTheme.raised)
                        .overlay {
                            RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                                .stroke(UnfiledTheme.persimmon.opacity(0.6), lineWidth: 1)
                        }
                        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(isPreparingExport || isDeletingAccount)
                .accessibilityHint("Opens a typed confirmation before deleting anything")
                .accessibilityIdentifier(AccountDataAccessibilityIdentifier.delete)

                if let deletionError {
                    dataError(deletionError, identifier: AccountDataAccessibilityIdentifier.deleteError)
                }
            }
        }
        .padding(.vertical, 22)
        .overlay(alignment: .bottom) { SectionRule() }
        .sheet(isPresented: exportSheetBinding) {
            if let exportArtifact {
                ZStack {
                    AccountExportActivityView(artifact: exportArtifact) {
                        onDiscardExport(exportArtifact)
                    }
                    if scenePhase != .active {
                        PrivacyCurtainView()
                            .zIndex(100)
                    }
                }
                .presentationDetents([.medium, .large])
            }
        }
        .sheet(isPresented: $showsDeletionConfirmation, onDismiss: clearConfirmation) {
            ZStack {
                deletionConfirmation
                if scenePhase != .active {
                    PrivacyCurtainView()
                        .zIndex(100)
                }
            }
        }
        .onDisappear {
            if let exportArtifact { onDiscardExport(exportArtifact) }
            clearConfirmation()
        }
    }

    private var exportSheetBinding: Binding<Bool> {
        Binding(
            get: { exportArtifact != nil },
            set: { presented in
                if !presented, let exportArtifact { onDiscardExport(exportArtifact) }
            }
        )
    }

    private var deletionConfirmation: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    EditorialEyebrow(text: "Permanent action")
                    Text("Delete your Unfiled account?")
                        .font(.largeTitle.weight(.bold))
                        .tracking(-1.2)
                        .accessibilityAddTraits(.isHeader)
                    Text("Live notes, captures, indexes, settings, and sessions are deleted. Backups age out after 30 days. This cannot be undone from the app.")
                        .font(.body)
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)

                    VStack(alignment: .leading, spacing: 8) {
                        Text("TYPE DELETE TO CONTINUE")
                            .font(.caption.weight(.medium).monospaced())
                            .tracking(0.8)
                            .foregroundStyle(UnfiledTheme.fog)
                        TextField("DELETE", text: $confirmation)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .keyboardType(.asciiCapable)
                            .font(.body.monospaced())
                            .padding(.horizontal, 14)
                            .frame(minHeight: 52)
                            .background(UnfiledTheme.raised)
                            .overlay {
                                RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius)
                                    .stroke(UnfiledTheme.persimmon.opacity(0.7), lineWidth: 1)
                            }
                            .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                            .focused($confirmationFocused)
                            .accessibilityLabel("Type DELETE to confirm account deletion")
                            .accessibilityIdentifier(
                                AccountDataAccessibilityIdentifier.deleteConfirmation
                            )
                    }

                    if let deletionError {
                        dataError(
                            deletionError,
                            identifier: AccountDataAccessibilityIdentifier.deleteError
                        )
                    }

                    Button(role: .destructive) {
                        confirmationFocused = false
                        Task { @MainActor in
                            if await onDeleteAccount() {
                                showsDeletionConfirmation = false
                            }
                        }
                    } label: {
                        HStack(spacing: 10) {
                            if isDeletingAccount { ProgressView().tint(UnfiledTheme.paper) }
                            Text(isDeletingAccount ? "Deleting account…" : "Permanently delete account")
                        }
                        .font(.body.weight(.semibold))
                        .foregroundStyle(UnfiledTheme.paper)
                        .frame(maxWidth: .infinity, minHeight: 52)
                        .background(confirmationIsExact ? UnfiledTheme.persimmon : UnfiledTheme.fog)
                        .clipShape(RoundedRectangle(cornerRadius: UnfiledTheme.controlRadius))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .disabled(!confirmationIsExact || isDeletingAccount)
                    .accessibilityIdentifier(AccountDataAccessibilityIdentifier.deleteCommit)

                    Button("Cancel") { showsDeletionConfirmation = false }
                        .buttonStyle(.bordered)
                        .tint(UnfiledTheme.fog)
                        .frame(maxWidth: .infinity, minHeight: 50)
                }
                .padding(UnfiledTheme.screenPadding)
            }
            .navigationBarTitleDisplayMode(.inline)
            .unfiledScreen()
            .onAppear { confirmationFocused = true }
        }
    }

    private var confirmationIsExact: Bool {
        AccountDataPresentation.deletionConfirmationIsExact(confirmation)
    }

    private func clearConfirmation() {
        confirmationFocused = false
        confirmation.removeAll(keepingCapacity: false)
    }

    private func dataError(_ message: String, identifier: String) -> some View {
        Label(message, systemImage: "exclamationmark.triangle.fill")
            .font(.footnote)
            .foregroundStyle(UnfiledTheme.persimmon)
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(identifier)
    }
}

private struct AccountExportActivityView: UIViewControllerRepresentable {
    let artifact: AccountExportArtifact
    let onComplete: @MainActor () -> Void

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(
            activityItems: [artifact.fileURL],
            applicationActivities: nil
        )
        controller.completionWithItemsHandler = { _, _, _, _ in
            Task { @MainActor in onComplete() }
        }
        return controller
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

struct AccountDeletionReceiptView: View {
    let presentation: AccountDeletionReceiptPresentation
    let onDismiss: @MainActor () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    UnfiledMark(size: 42)
                    EditorialEyebrow(text: "Deletion receipt")
                    Text("Account deleted")
                        .font(.largeTitle.weight(.bold))
                        .tracking(-1.2)
                        .accessibilityAddTraits(.isHeader)
                    Label("All sessions revoked", systemImage: "checkmark.shield")
                        .font(.headline)
                    receiptRow("Deleted", value: presentation.receipt.deletedAt)
                    receiptRow("Backups expire", value: presentation.receipt.backupExpiresAt)
                    Text("\(presentation.deletedRecordCount) live records were removed. Signing up again starts fresh.")
                        .font(.body)
                        .foregroundStyle(UnfiledTheme.fog)
                    if !presentation.localCleanupComplete {
                        Label(
                            "The server deletion succeeded, but this iPhone could not finish clearing its encrypted local profile or credentials. Reinstall Unfiled before lending or selling this device.",
                            systemImage: "exclamationmark.triangle.fill"
                        )
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(UnfiledTheme.persimmon)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    Button("Done", action: onDismiss)
                        .buttonStyle(.borderedProminent)
                        .tint(UnfiledTheme.persimmon)
                        .foregroundStyle(UnfiledTheme.ink)
                        .frame(maxWidth: .infinity, minHeight: 52)
                }
                .padding(UnfiledTheme.screenPadding)
            }
            .unfiledScreen()
        }
        .interactiveDismissDisabled()
        .accessibilityIdentifier(AccountDataAccessibilityIdentifier.receipt)
    }

    private func receiptRow(_ label: String, value: Date) -> some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline) {
                Text(label).foregroundStyle(UnfiledTheme.fog)
                Spacer(minLength: 12)
                receiptDate(value)
                    .multilineTextAlignment(.trailing)
            }
            VStack(alignment: .leading, spacing: 4) {
                Text(label).foregroundStyle(UnfiledTheme.fog)
                receiptDate(value)
            }
        }
    }

    private func receiptDate(_ value: Date) -> some View {
        Text(value, format: .dateTime.month(.abbreviated).day().year().hour().minute())
            .font(.footnote.monospaced())
    }
}
