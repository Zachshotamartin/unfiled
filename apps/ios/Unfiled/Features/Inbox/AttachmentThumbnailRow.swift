import SwiftUI

/// Lets any screen load an attachment's bytes through the model without threading a callback
/// through every view.
struct AttachmentLoaderKey: EnvironmentKey {
    static let defaultValue: @MainActor (String) async -> Data? = { _ in nil }
}

extension EnvironmentValues {
    var attachmentLoader: @MainActor (String) async -> Data? {
        get { self[AttachmentLoaderKey.self] }
        set { self[AttachmentLoaderKey.self] = newValue }
    }
}

/// Small thumbnails of what a capture carries, so the Inbox and Review show the photos and the
/// recording, not only the words.
struct AttachmentThumbnailRow: View {
    let attachments: [ReceiptAttachmentPresentation]
    @Environment(\.attachmentLoader) private var load

    var body: some View {
        HStack(spacing: 8) {
            ForEach(attachments) { attachment in
                if attachment.kind == .image {
                    AttachmentThumbnail(attachmentID: attachment.id, load: load)
                } else {
                    HStack(spacing: 6) {
                        GlyphView(glyph: .microphone, size: 14, weight: 1.9)
                        Text("Recording")
                            .font(UnfiledType.caption)
                    }
                    .foregroundStyle(UnfiledTheme.paper)
                    .padding(.horizontal, 10)
                    .frame(height: 56)
                    .background(UnfiledTheme.raised)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityLabel("Recording")
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("attachments.thumbnails")
    }
}

private struct AttachmentThumbnail: View {
    let attachmentID: String
    let load: @MainActor (String) async -> Data?
    @State private var image: UIImage?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable()
                    .scaledToFill()
            } else {
                UnfiledTheme.raised
            }
        }
        .frame(width: 56, height: 56)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .accessibilityLabel("Photo")
        .task(id: attachmentID) {
            guard image == nil, let data = await load(attachmentID) else { return }
            image = UIImage(data: data)
        }
    }
}
