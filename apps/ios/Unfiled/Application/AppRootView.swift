import SwiftUI

struct AppRootView: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var model: AppModel

    var body: some View {
        ZStack(alignment: .top) {
            switch model.phase {
            case .booting:
                LaunchLedgerView()
            case .signedOut:
                AuthenticationFlowView(model: model)
            case .signedIn:
                AppShellView(model: model)
            case let .failed(message):
                ProtectedStorageFailureView(message: message)
            }

            if let message = model.bannerMessage {
                AppBanner(message: message) {
                    model.bannerMessage = nil
                }
                .padding(.horizontal, 14)
                .padding(.top, 8)
                .transition(.move(edge: .top).combined(with: .opacity))
                .zIndex(10)
            }

            if scenePhase != .active {
                PrivacyCurtainView()
                    .transition(.identity)
                    .zIndex(100)
            }
        }
        .animation(.easeOut(duration: 0.18), value: model.bannerMessage)
        .sheet(item: accountDeletionReceiptBinding) { receipt in
            ZStack {
                AccountDeletionReceiptView(
                    presentation: receipt,
                    onDismiss: model.dismissAccountDeletionReceipt
                )
                if scenePhase != .active {
                    PrivacyCurtainView()
                        .zIndex(100)
                }
            }
        }
        .onChange(of: scenePhase) { _, newPhase in
            Task { @MainActor in
                if newPhase == .active {
                    await model.becameActive()
                } else {
                    await model.becameInactive()
                }
            }
        }
        .preferredColorScheme(.dark)
    }

    private var accountDeletionReceiptBinding: Binding<AccountDeletionReceiptPresentation?> {
        Binding(
            get: { model.accountDeletionReceipt },
            set: { value in
                if value == nil { model.dismissAccountDeletionReceipt() }
            }
        )
    }
}

struct PrivacyCurtainView: View {
    var body: some View {
        ZStack {
            UnfiledTheme.ink
                .ignoresSafeArea()
            VStack(spacing: 16) {
                UnfiledMark(size: 46)
                Text("unfiled")
                    .font(.system(size: 24, weight: .bold))
                    .tracking(-0.8)
                    .foregroundStyle(UnfiledTheme.paper)
            }
        }
        .accessibilityHidden(true)
    }
}

private struct AuthenticationFlowView: View {
    @ObservedObject var model: AppModel

    var body: some View {
        PasswordSignInView(
            mode: $model.authMode,
            onSubmit: { request, mode in
                mode == .signUp ? try await model.signUp(request) : try await model.signIn(request)
            },
            onSignedIn: { session in
                Task { @MainActor in await model.acceptVerifiedSession(session) }
            }
        )
    }
}

private struct LaunchLedgerView: View {
    var body: some View {
        VStack(spacing: 22) {
            UnfiledMark(size: 66)
            Text("unfiled")
                .font(.system(size: 34, weight: .bold))
                .tracking(-1)
            ProgressView()
                .tint(UnfiledTheme.persimmon)
                .accessibilityLabel("Opening protected storage")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .unfiledScreen()
    }
}

private struct ProtectedStorageFailureView: View {
    let message: String

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            UnfiledMark(size: 48)
            EditorialEyebrow(text: "Protected storage")
            Text("Unfiled could not open")
                .font(.system(size: 34, weight: .bold))
            Text(message)
                .font(.body)
                .foregroundStyle(UnfiledTheme.fog)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(UnfiledTheme.screenPadding)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .unfiledScreen()
    }
}

private struct AppBanner: View {
    let message: String
    let onDismiss: @MainActor () -> Void

    var body: some View {
        HStack(spacing: 12) {
            UnfiledMark(size: 24)
            Text(message)
                .font(.system(size: 13, weight: .medium))
                .foregroundStyle(UnfiledTheme.paper)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 4)
            Button("Dismiss", systemImage: "xmark", action: onDismiss)
                .labelStyle(.iconOnly)
                .foregroundStyle(UnfiledTheme.fog)
                .frame(width: 44, height: 44)
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .padding(.vertical, 5)
        .background(UnfiledTheme.raised)
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(UnfiledTheme.border, lineWidth: 1)
        }
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .accessibilityElement(children: .contain)
    }
}
