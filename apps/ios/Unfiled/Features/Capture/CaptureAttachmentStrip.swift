import SwiftUI

/// A photo or recording the owner added to the capture they are writing.
struct PendingCaptureAttachment: Identifiable, Equatable {
    let id: String
    let kind: LocalAttachmentKind
    let mediaType: String
    let bytes: Data
    let width: Int?
    let height: Int?
    let durationMs: Int?

    var draft: CaptureAttachmentDraft {
        CaptureAttachmentDraft(
            id: id, kind: kind, mediaType: mediaType, bytes: bytes,
            width: width, height: height, durationMs: durationMs
        )
    }
}

/// Thumbnails of what will go with the capture, each with its own remove control, so the owner
/// sees exactly what they are sending before the arrow.
struct CaptureAttachmentStrip: View {
    let attachments: [PendingCaptureAttachment]
    let onRemove: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(attachments) { attachment in
                    ZStack(alignment: .topTrailing) {
                        thumbnail(attachment)
                            .frame(width: 84, height: 84)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        Button {
                            onRemove(attachment.id)
                        } label: {
                            GlyphView(glyph: .close, size: 12, weight: 2)
                                .foregroundStyle(UnfiledTheme.ink)
                                .frame(width: 28, height: 28)
                                .background(UnfiledTheme.paper.opacity(0.85))
                                .clipShape(Circle())
                        }
                        .padding(4)
                        .accessibilityLabel("Remove photo")
                    }
                    .accessibilityElement(children: .contain)
                }
            }
            .padding(.horizontal, UnfiledTheme.screenPadding)
            .padding(.vertical, 8)
        }
        .accessibilityIdentifier("capture.attachments")
    }

    @ViewBuilder
    private func thumbnail(_ attachment: PendingCaptureAttachment) -> some View {
        if let image = UIImage(data: attachment.bytes) {
            Image(uiImage: image)
                .resizable()
                .scaledToFill()
                .accessibilityLabel("Photo")
        } else {
            UnfiledTheme.raised
                .accessibilityLabel("Photo")
        }
    }
}
