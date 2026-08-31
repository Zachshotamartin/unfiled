import SwiftUI

struct SettingsView: View {
    let email: String
    let apiHost: String
    let onSignOut: @MainActor () async -> Void

    @State private var confirmsSignOut = false
    @State private var isSigningOut = false

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                EditorialEyebrow(text: "Account and device")
                    .padding(.top, 16)
                Text("Settings")
                    .font(.system(size: 44, weight: .bold))
                    .tracking(-1.7)
                    .padding(.top, 8)
                    .padding(.bottom, 26)

                settingsSection("Signed in") {
                    Label(email, systemImage: "person.crop.circle")
                    metadata("Shared backend", value: apiHost)
                }

                settingsSection("Protected storage") {
                    Label("SQLCipher-encrypted local database", systemImage: "lock.shield")
                    Text("This iPhone stores drafts, cached notes, and pending captures in SQLCipher. Its key stays in this device’s Keychain and is not synchronized to iCloud. AI-assisted content is sent over HTTPS to the authorized Unfiled backend. Server-side storage protections depend on that deployment and are not verified by this screen.")
                        .font(.system(size: 14))
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)
                }

                settingsSection("Lock Screen capture") {
                    Label("Quick Capture widget", systemImage: "rectangle.on.rectangle")
                    Text("Touch and hold the Lock Screen, choose Customize, tap the widget area, then add Unfiled. A tap opens the native composer with the keyboard ready; iOS does not allow free-form typing inside the widget itself.")
                        .font(.system(size: 14))
                        .foregroundStyle(UnfiledTheme.fog)
                        .fixedSize(horizontal: false, vertical: true)
                }

                Button(role: .destructive) {
                    confirmsSignOut = true
                } label: {
                    HStack {
                        Text(isSigningOut ? "Signing out…" : "Sign out")
                        Spacer()
                        if isSigningOut { ProgressView() }
                    }
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(UnfiledTheme.persimmon)
                    .frame(minHeight: 54)
                }
                .buttonStyle(.plain)
                .disabled(isSigningOut)
                .padding(.top, 26)
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.bottom, 48)
        }
        .confirmationDialog(
            "Sign out on this iPhone?",
            isPresented: $confirmsSignOut,
            titleVisibility: .visible
        ) {
            Button("Sign out", role: .destructive) { signOut() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Pending captures remain encrypted and account-scoped on this device until you sign in again.")
        }
        .navigationBarTitleDisplayMode(.inline)
        .unfiledScreen()
    }

    private func settingsSection<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .tracking(1)
                .foregroundStyle(UnfiledTheme.fog)
            content()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 22)
        .overlay(alignment: .bottom) { SectionRule() }
    }

    private func metadata(_ label: String, value: String) -> some View {
        HStack {
            Text(label).foregroundStyle(UnfiledTheme.fog)
            Spacer()
            Text(value).font(.system(size: 12, design: .monospaced))
        }
        .font(.system(size: 14))
    }

    private func signOut() {
        isSigningOut = true
        Task { @MainActor in
            await onSignOut()
            isSigningOut = false
        }
    }
}
