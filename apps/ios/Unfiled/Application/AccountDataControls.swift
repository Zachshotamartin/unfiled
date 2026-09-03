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

    /// Two rows in the Account group. The export streams into a protected temporary file and
    /// opens the share sheet; deletion opens a typed confirmation. Both keep their sheets here.
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            SettingsButtonRow(
                title: isPreparingExport ? "Preparing private export…" : "Export my data",
                glyph: .send,
                isBusy: isPreparingExport,
                isDisabled: isDeletingAccount,
                accessibilityHint: "Streams a private archive into a protected temporary file, then opens the share sheet",
                accessibilityIdentifier: AccountDataAccessibilityIdentifier.export
            ) {
                Task { await onPrepareExport() }
            }
            if let exportError {
                dataError(exportError, identifier: AccountDataAccessibilityIdentifier.exportError)
                    .settingsRow()
            }

            SettingsButtonRow(
                title: hasPendingDeletionReplay ? "Confirm pending deletion" : "Delete account",
                glyph: .trash,
                emphasis: .accent,
                isDisabled: isPreparingExport || isDeletingAccount,
                accessibilityHint: "Opens a typed confirmation before deleting anything",
                accessibilityIdentifier: AccountDataAccessibilityIdentifier.delete
            ) {
                confirmation = ""
                showsDeletionConfirmation = true
            }
            if hasPendingDeletionReplay {
                SettingsInlineMessage(
                    message: "An earlier deletion is awaiting confirmation. Retry uses the same protected recovery key.",
                    kind: .warning
                )
                .settingsRow()
            }
            if let deletionError {
                dataError(deletionError, identifier: AccountDataAccessibilityIdentifier.deleteError)
                    .settingsRow()
            }
        }
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
                        .font(UnfiledType.display)
                        .tracking(UnfiledType.displayTracking)
                        .accessibilityAddTraits(.isHeader)
                    Text("Live notes, captures, indexes, settings, and sessions are deleted. Backups age out after 30 days. This cannot be undone from the app.")
                        .font(UnfiledType.body)
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)

                    VStack(alignment: .leading, spacing: 8) {
                        EditorialEyebrow(text: "Type DELETE to continue")
                        TextField("DELETE", text: $confirmation)
                            .textInputAutocapitalization(.characters)
                            .autocorrectionDisabled()
                            .keyboardType(.asciiCapable)
                            .font(UnfiledType.body)
                            .padding(.horizontal, UnfiledTheme.fieldPadding)
                            .frame(minHeight: UnfiledTheme.controlHeight)
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
                        .font(UnfiledType.heading)
                        .foregroundStyle(UnfiledTheme.paper)
                        .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
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
                        .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
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
        SettingsInlineMessage(message: message, kind: .error, accessibilityIdentifier: identifier)
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
                    EditorialEyebrow(text: "Deletion receipt")
                    Text("Account deleted")
                        .font(UnfiledType.display)
                        .tracking(UnfiledType.displayTracking)
                        .accessibilityAddTraits(.isHeader)
                    Label {
                        Text("All sessions revoked")
                    } icon: {
                        GlyphView(glyph: .check, size: 16, weight: 2)
                            .foregroundStyle(UnfiledTheme.persimmon)
                    }
                    .font(UnfiledType.heading)
                    receiptRow("Deleted", value: presentation.receipt.deletedAt)
                    receiptRow("Backups expire", value: presentation.receipt.backupExpiresAt)
                    Text("\(presentation.deletedRecordCount) live records were removed. Signing up again starts fresh.")
                        .font(UnfiledType.body)
                        .foregroundStyle(UnfiledTheme.fog)
                    if !presentation.localCleanupComplete {
                        SettingsInlineMessage(
                            message: "The server deletion succeeded, but this iPhone could not finish clearing its encrypted local profile or credentials. Reinstall Unfiled before lending or selling this device.",
                            kind: .error
                        )
                    }
                    Button("Done", action: onDismiss)
                        .buttonStyle(.borderedProminent)
                        .tint(UnfiledTheme.persimmon)
                        .foregroundStyle(UnfiledTheme.ink)
                        .frame(maxWidth: .infinity, minHeight: UnfiledTheme.controlHeight)
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
            .font(UnfiledType.caption)
    }
}
