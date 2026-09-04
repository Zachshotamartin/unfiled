import SwiftUI
import UIKit
import XCTest
@testable import Unfiled

/// Renders the code-entry screen to PNG files for human visual review.
///
/// The test is skipped unless `UNFILED_AUTH_SNAPSHOT_DIR` names a writable directory (pass it
/// through xcodebuild as `TEST_RUNNER_UNFILED_AUTH_SNAPSHOT_DIR`), so CI never depends on host
/// paths. Every fixture is synthetic: the address is an example, and no request is made.
@MainActor
final class AuthViewSnapshotTests: XCTestCase {
    private static let phoneWidth: CGFloat = 393
    private static let phoneHeight: CGFloat = 852
    private static let environmentKey = "UNFILED_AUTH_SNAPSHOT_DIR"

    func testRendersTheCodeEntryScreenForVisualReview() async throws {
        guard let path = ProcessInfo.processInfo.environment[Self.environmentKey], !path.isEmpty else {
            throw XCTSkip("Set \(Self.environmentKey) to write review snapshots")
        }
        let directory = URL(fileURLWithPath: path, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

        // A code just sent, so the resend control shows its wait, and one sent long enough ago that
        // asking for another is available again.
        try await render(
            name: "verify.waiting",
            pending: PendingVerification(email: "person@example.com", codeSentAt: Date()),
            into: directory
        )
        try await render(
            name: "verify.resend-available",
            pending: PendingVerification(
                email: "person@example.com",
                codeSentAt: Date().addingTimeInterval(-600)
            ),
            into: directory
        )
    }

    private func render(
        name: String,
        pending: PendingVerification,
        into directory: URL
    ) async throws {
        let scene = try XCTUnwrap(
            UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.first,
            "The test host needs a window scene to lay out SwiftUI"
        )
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: Self.phoneWidth, height: Self.phoneHeight)
        let host = UIHostingController(
            rootView: VerifyEmailView(
                pending: pending,
                onVerify: { _ in throw APIClientError.transportFailure },
                onResend: {},
                onLeave: {},
                onSignedIn: { _ in }
            )
        )
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }

        try await Task.sleep(for: .milliseconds(450))
        host.view.layoutIfNeeded()

        let format = UIGraphicsImageRendererFormat()
        format.scale = 2
        let image = UIGraphicsImageRenderer(bounds: window.bounds, format: format).image { context in
            window.layer.render(in: context.cgContext)
        }
        let data = try XCTUnwrap(image.pngData(), "\(name) produced no image data")
        try data.write(to: directory.appendingPathComponent("\(name).png"), options: .atomic)
    }
}
